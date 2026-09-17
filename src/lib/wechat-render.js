import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { JSDOM } from 'jsdom';
import { createWechatClient } from '@wenyan-md/core/wechat';
import { defaultHttpAdapter } from '@wenyan-md/core/http';
import { prepareRenderContext, publishToWechatDraft, wechatPublisher } from '@wenyan-md/core/wrapper';
import { fetchWithTimeout } from './http-timeout.js';
import {
  MATH_TOKEN_RE,
  protectMathInMarkdown,
  renderEquationPngs,
  restoreMathInHtml,
  validateMathRestored,
} from './wechat-math.js';
import { restyleSectionHeadings } from './wechat-heading.js';

const wechatRequestContext = new AsyncLocalStorage();
const boundedWechatClient = createWechatClient({
  ...defaultHttpAdapter,
  fetch(resource, options) {
    const context = wechatRequestContext.getStore() || {};
    return fetchWithTimeout(context.fetchFn || globalThis.fetch, resource, options, {
      timeoutMs: context.timeoutMs || 30000,
      signal: context.signal,
      label: '微信 API',
    });
  },
});

// Wenyan's publisher keeps token and asset caches, while its default transport has no timeout. Replace only its
// network method at module initialization so caching and rendering stay unchanged; AsyncLocalStorage isolates request options.
wechatPublisher.fetchAccessToken = boundedWechatClient.fetchAccessToken;
wechatPublisher.uploadMaterial = boundedWechatClient.uploadMaterial;
wechatPublisher.publishArticle = boundedWechatClient.publishArticle;
wechatPublisher._listDraftsFn = boundedWechatClient.listDrafts;
wechatPublisher._getDraftFn = boundedWechatClient.getDraft;
wechatPublisher._updateDraftFn = boundedWechatClient.updateDraft;

// Formula-heavy articles produce many small equation images. wenyan's uploadImages
// fires every upload concurrently and repeats identical files; gate uploads through
// a small concurrency window and reuse an in-process content-hash cache so repeated
// files (deduped formulas, covers on retries) upload once.
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_RETRY_DELAY_MS = 1000;
const uploadCache = new Map();
let uploadInFlight = 0;
const uploadWaiters = [];

function uploadQueueSlot(task) {
  return new Promise((resolve) => {
    const resume = () => {
      uploadInFlight += 1;
      resolve();
    };
    if (uploadInFlight < UPLOAD_CONCURRENCY) {
      uploadInFlight += 1;
      resolve();
    } else {
      uploadWaiters.push(resume);
    }
  }).then(async () => {
    try {
      return await task();
    } finally {
      uploadInFlight -= 1;
      const next = uploadWaiters.shift();
      if (next) next();
    }
  });
}

function installUploadGate() {
  if (wechatPublisher.__zenUploadGate) return;
  wechatPublisher.__zenUploadGate = true;
  const previous = wechatPublisher.uploadImage.bind(wechatPublisher);
  wechatPublisher.uploadImage = async function zenUploadImage(file, filename, accessToken, appId) {
    let cacheKey;
    try {
      if (file && typeof file.arrayBuffer === 'function') {
        const buffer = Buffer.from(await file.arrayBuffer());
        cacheKey = `${appId || ''}:${createHash('sha256').update(buffer).digest('hex')}`;
        const cached = uploadCache.get(cacheKey);
        if (cached) return cached;
      }
    } catch (error) {
      cacheKey = undefined;
      console.error('图片上传去重缓存失败,回退直传:', error?.message || error);
    }
    if (cacheKey) {
      let result;
      for (let attempt = 1; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await uploadQueueSlot(() => previous(file, filename, accessToken, appId));
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          console.error('图片上传失败,重试一次:', error?.message || error);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
        }
      }
      if (result?.media_id && result?.url) uploadCache.set(cacheKey, result);
      return result;
    }
    return previous(file, filename, accessToken, appId);
  };
}
installUploadGate();

export async function renderAndPublishWithFinalFooter(inputContent, options, getInputContent) {
  const { content, absoluteDirPath } = await getInputContent(inputContent, options.file);
  // Protect math before the markdown renderer can fragment it, rasterize each
  // formula to a PNG inside the run directory, and restore the images after styling.
  const protection = protectMathInMarkdown(content);
  if (protection.equations.length) {
    if (!absoluteDirPath) throw new Error('公式渲染缺少隔离工作目录');
    await renderEquationPngs(protection.equations, {
      outDir: absoluteDirPath,
      executablePath: options.mathBrowserExecutablePath || options.headingBrowserExecutablePath,
      signal: options.signal,
    });
    const cjkCount = protection.equations.filter((equation) => equation.hasCjk).length;
    if (cjkCount && options.onMathCjkEquation) {
      try { await options.onMathCjkEquation(cjkCount); }
      catch (warnErr) { console.error('公式中文字形提醒失败(不影响流程):', warnErr); }
    }
  }
  const rendered = await prepareRenderContext(undefined, options, async () => ({
    content: protection.markdown,
    absoluteDirPath,
  }));
  const gzhContent = rendered.gzhContent;
  if (!gzhContent?.title) throw new Error('未能找到文章标题');
  const styledMathHtml = restoreMathInHtml(
    await restyleSectionHeadings(
      styleKeyHighlights(alignTerminalReferences(removeDuplicateReferenceSections(gzhContent.content))),
      {
        stripOrdinals: options.stripHeadingOrdinals === true,
        absoluteDirPath,
        executablePath: options.headingBrowserExecutablePath,
        signal: options.signal,
        renderCards: options.renderHeadingCards,
      },
    ),
    { equations: protection.equations },
  );
  if (protection.equations.length) validateMathRestored(styledMathHtml, { equations: protection.equations });
  gzhContent.content = normalizeCodeBreaks(normalizeBodyTypography(normalizeListMarkers(styledMathHtml)));
  if (options.finalSurveyPath || options.finalFooterPath) {
    gzhContent.content = appendFinalTailImages(gzhContent.content, {
      surveyPath: options.finalSurveyPath,
      footerPath: options.finalFooterPath,
    });
  }
  validatePreparedWechatHtml(gzhContent.content, {
    absoluteDirPath,
    finalSurveyPath: options.finalSurveyPath,
    finalFooterPath: options.finalFooterPath,
  });
  const data = await wechatRequestContext.run({
    timeoutMs: options.timeoutMs || 30000,
    signal: options.signal,
    fetchFn: options.fetchFn || globalThis.fetch,
  }, () => publishToWechatDraft(gzhContent, {
    appId: options.appId,
    appSecret: options.appSecret,
    relativePath: absoluteDirPath,
  }));
  if (!data?.media_id) throw new Error(`发布到微信公众号失败:${JSON.stringify(data)}`);
  return data.media_id;
}

export async function recoverWechatDraft({
  appId,
  appSecret,
  mediaId,
  timeoutMs = 30000,
  signal,
  fetchFn = globalThis.fetch,
}) {
  if (!appId || !appSecret || !mediaId) throw new Error('微信草稿恢复参数不完整');
  return wechatRequestContext.run({ timeoutMs, signal, fetchFn }, async () => {
    const accessToken = await wechatPublisher.getAccessTokenWithCache(appId, appSecret);
    return wechatPublisher.getDraft(accessToken, mediaId);
  });
}

export function normalizeCodeBreaks(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  for (const lineBreak of document.querySelectorAll('pre > code br')) {
    lineBreak.replaceWith(document.createTextNode('\n'));
  }
  return document.body.innerHTML;
}

export function validatePreparedWechatHtml(html, {
  absoluteDirPath,
  finalSurveyPath,
  finalFooterPath,
} = {}) {
  const errors = [];
  const value = String(html || '');
  if (!value.trim()) errors.push('最终 HTML 为空');
  if (value.includes('\uFFFD')) errors.push('最终 HTML 含 Unicode 替换字符，疑似乱码');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) errors.push('最终 HTML 含控制字符');
  if (/source-page-\d+\.(?:png|jpe?g|gif|webp)/i.test(value)) errors.push('最终 HTML 含禁止的 PDF 整页截图');

  const document = new JSDOM(`<body>${value}</body>`).window.document;
  const dangerous = document.querySelectorAll('script,style,iframe,object,embed');
  if (dangerous.length) errors.push(`最终 HTML 含 ${dangerous.length} 个禁止的可执行或嵌入节点`);
  if (value.match(MATH_TOKEN_RE)) errors.push('最终 HTML 残留未恢复的公式占位符');
  if (document.querySelector('mjx-container')) errors.push('最终 HTML 残留 MathJax 渲染容器,公式必须为图片');
  if ([...document.querySelectorAll('svg')].some((svg) => svg.querySelector('[data-mml-node="math"]'))) {
    errors.push('最终 HTML 残留 MathJax 公式 SVG,公式必须为图片');
  }
  for (const [index, pre] of [...document.querySelectorAll('pre')].entries()) {
    const code = pre.children.length === 1 && pre.firstElementChild?.tagName === 'CODE'
      ? pre.firstElementChild
      : undefined;
    if (!code) {
      errors.push(`第 ${index + 1} 个代码块缺少唯一的 code 子节点`);
      continue;
    }
    if (!code.textContent.trim()) errors.push(`第 ${index + 1} 个代码块为空`);
    if ([...code.querySelectorAll('*')].some((node) => node.tagName !== 'SPAN')) {
      errors.push(`第 ${index + 1} 个代码块含非语法高亮子节点`);
    }
  }
  const sourceInfoLabels = [...document.querySelectorAll('strong')]
    .filter((node) => node.textContent.trim() === '原文信息');
  if (sourceInfoLabels.length > 1) errors.push(`最终 HTML 含 ${sourceInfoLabels.length} 个“原文信息”板块`);
  const oversizedBodyNodes = [...document.querySelectorAll('p,li,blockquote')]
    .filter((node) => !node.closest('[data-zen-final-tail-wrapper],[data-zen-section-heading]'))
    .filter((node) => {
      const size = effectiveEmFontSize(node);
      return size !== undefined && size > 0.9;
    });
  if (oversizedBodyNodes.length) {
    errors.push(`最终 HTML 含 ${oversizedBodyNodes.length} 个大于正文字号的非标题文字块`);
  }
  for (const [index, image] of [...document.querySelectorAll('img')].entries()) {
    const src = image.getAttribute('src') || image.getAttribute('data-src') || '';
    if (!src) {
      errors.push(`第 ${index + 1} 张图片缺少 src`);
      continue;
    }
    if (/^https?:/i.test(src) && !/^https:\/\/mmbiz\.qpic\.cn(?:\/|$)/i.test(src)) {
      errors.push(`第 ${index + 1} 张图片仍是未本地化的外部 URL:${src}`);
      continue;
    }
    if (/^asset:/i.test(src)) continue;
    if (/^(?:data:|\/\/)/i.test(src)) {
      errors.push(`第 ${index + 1} 张图片使用不受支持的内联或协议相对地址:${src.slice(0, 120)}`);
      continue;
    }
    if (/^https?:/i.test(src)) continue;
    const resolved = pathForHtmlAsset(src, absoluteDirPath);
    if (!resolved || !fsExists(resolved)) {
      errors.push(`第 ${index + 1} 张本地图片不存在:${src}`);
      continue;
    }
    const unsupportedFormat = unsupportedWechatImageFormat(resolved);
    if (unsupportedFormat) {
      errors.push(`第 ${index + 1} 张本地图片为微信不支持的 ${unsupportedFormat} 格式:${src}`);
    }
  }
  for (const [index, table] of [...document.querySelectorAll('table')].entries()) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length || rows.some((row) => !row.querySelector('th,td'))) {
      errors.push(`第 ${index + 1} 个表格结构为空或损坏`);
    }
  }
  if (finalSurveyPath || finalFooterPath) {
    errors.push(...validateFinalTailOrder(document, { finalSurveyPath, finalFooterPath }));
  }
  if (errors.length) throw new Error(`微信最终 HTML 完整性校验失败:${errors.join('; ')}`);
  return { images: document.querySelectorAll('img').length, tables: document.querySelectorAll('table').length };
}

export function normalizeBodyTypography(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  const bodyFont = '"PingFang SC","PingFang TC",-apple-system,BlinkMacSystemFont,"Hiragino Sans GB","Microsoft YaHei",sans-serif';
  const bodyNodes = [...document.querySelectorAll('blockquote,li')];
  for (const node of bodyNodes) {
    const nested = Boolean(node.parentElement?.closest('blockquote,li'));
    node.style.fontFamily = bodyFont;
    node.style.fontSize = nested ? '1em' : '.88em';
    node.style.fontWeight = '300';
    node.style.lineHeight = '1.6';
  }
  // Wenyan wraps loose-list content in a paragraph. Its inline `.88em` would otherwise
  // compound with the list item's `.88em`, making list copy visibly smaller than body copy.
  for (const paragraph of document.querySelectorAll('blockquote p,li p')) {
    paragraph.style.fontFamily = bodyFont;
    paragraph.style.fontSize = '1em';
    paragraph.style.fontWeight = '300';
    paragraph.style.lineHeight = '1.6';
  }
  return document.body.innerHTML;
}

// WeChat does not retain CSS pseudo-elements from the custom theme. The theme's
// `li::before` markers therefore disappear unless they are materialized into the
// final HTML. Derive ordered values from HTML list semantics so start/value/reversed
// numbering remains faithful instead of inventing or resetting item numbers.
export function normalizeListMarkers(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  for (const list of document.querySelectorAll('ol,ul')) {
    const items = [...list.children].filter((child) => child.tagName === 'LI');
    const ordered = list.tagName === 'OL';
    const reversed = ordered && list.hasAttribute('reversed');
    const parsedStart = Number.parseInt(list.getAttribute('start') || '', 10);
    let ordinal = Number.isInteger(parsedStart)
      ? parsedStart
      : (reversed ? items.length : 1);

    for (const item of items) {
      if (item.querySelector(':scope > [data-zen-list-marker="true"],:scope > section > [data-zen-list-marker="true"],:scope > section > p > [data-zen-list-marker="true"],:scope > p > [data-zen-list-marker="true"]')) {
        if (ordered) ordinal += reversed ? -1 : 1;
        continue;
      }
      const explicitValue = Number.parseInt(item.getAttribute('value') || '', 10);
      if (ordered && Number.isInteger(explicitValue)) ordinal = explicitValue;

      const marker = document.createElement('span');
      marker.setAttribute('data-zen-list-marker', 'true');
      marker.setAttribute('aria-hidden', 'true');
      marker.setAttribute(
        'style',
        `font-family:inherit;font-size:1em;font-weight:700;color:${ordered ? '#2F7D54' : '#0E2138'};margin-right:.45em;`,
      );
      marker.textContent = ordered ? `${ordinal}.` : '▪';

      const paragraph = [...item.querySelectorAll('p')]
        .find((candidate) => candidate.closest('li') === item);
      if (paragraph) {
        paragraph.prepend(marker);
      } else {
        const section = [...item.children]
          .find((child) => child.tagName === 'SECTION');
        (section || item).prepend(marker);
      }
      if (ordered) ordinal += reversed ? -1 : 1;
    }
  }
  return document.body.innerHTML;
}

function pathForHtmlAsset(src, absoluteDirPath) {
  if (!absoluteDirPath) return undefined;
  try {
    const decoded = decodeURIComponent(String(src).split(/[?#]/)[0]);
    return decoded.startsWith('/') ? decoded : path.resolve(absoluteDirPath, decoded);
  } catch {
    return undefined;
  }
}

function fsExists(filename) {
  try { return fs.existsSync(filename) && fs.statSync(filename).size > 0; }
  catch { return false; }
}

function unsupportedWechatImageFormat(filename) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const header = Buffer.alloc(512);
    const length = fs.readSync(descriptor, header, 0, header.length, 0);
    const bytes = header.subarray(0, length);
    // Trust binary signatures before inspecting textual formats. Some valid
    // PNGs carry XMP/JUMBF metadata containing embedded SVG markup near the
    // beginning of the file; searching the raw binary for `<svg` misclassifies
    // those images even though WeChat can consume them normally.
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return undefined;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return undefined;
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return undefined;
    if (bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
      return 'WebP';
    }
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return 'SVG';
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
  return undefined;
}

function effectiveEmFontSize(node) {
  let size = 1;
  let found = false;
  for (let current = node; current && current.tagName !== 'BODY'; current = current.parentElement) {
    const raw = current.style?.fontSize?.trim();
    if (!raw) continue;
    const em = /^([0-9]*\.?[0-9]+)em$/i.exec(raw);
    const percent = /^([0-9]*\.?[0-9]+)%$/.exec(raw);
    if (em) {
      size *= Number(em[1]);
      found = true;
    } else if (percent) {
      size *= Number(percent[1]) / 100;
      found = true;
    }
  }
  return found ? size : undefined;
}

export function removeDuplicateReferenceSections(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  const isReferenceHeading = (node) => /^H[1-6]$/.test(node?.tagName || '')
    && node.textContent.trim() === '引用链接';
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(isReferenceHeading);
  if (headings.length <= 1) return document.body.innerHTML;
  const keep = headings.at(-1);

  for (const heading of headings.slice(0, -1)) {
    let cursor = heading.nextElementSibling;
    heading.remove();
    while (cursor && cursor !== keep && !isReferenceHeading(cursor)) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }
  return document.body.innerHTML;
}

export function styleKeyHighlights(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  for (const node of document.querySelectorAll('p strong,li strong,blockquote strong')) {
    const existing = node.getAttribute('style') || '';
    const separator = existing && !existing.trim().endsWith(';') ? ';' : '';
    node.setAttribute('style', `${existing}${separator}color:#294a63;font-weight:700;background:linear-gradient(transparent 58%,rgba(177,207,226,.5) 58%);padding:0 .08em;`);
    node.setAttribute('data-zen-key-highlight', 'true');
  }
  return document.body.innerHTML;
}

export function alignTerminalReferences(html) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .find((node) => ['引用链接', '引用来源'].includes(node.textContent.trim()));
  if (!heading) return document.body.innerHTML;

  let node = heading;
  while (node) {
    const existing = node.getAttribute('style') || '';
    node.setAttribute('style', `${existing}${existing && !existing.trim().endsWith(';') ? ';' : ''}text-align:left;`);
    for (const descendant of node.querySelectorAll?.('p,ol,ul,li,a') || []) {
      const childStyle = descendant.getAttribute('style') || '';
      descendant.setAttribute('style', `${childStyle}${childStyle && !childStyle.trim().endsWith(';') ? ';' : ''}text-align:left;`);
    }
    node = node.nextElementSibling;
  }
  return document.body.innerHTML;
}

export function appendFinalFooter(html, footerPath) {
  if (!footerPath) throw new Error('固定封底路径缺失');
  return appendTailDescriptors(html, [{
    path: footerPath,
    wrapperValue: 'footer',
    markerName: 'data-zen-final-footer',
    alt: 'Zen Trading 社群',
  }]);
}

export function appendFinalTailImages(html, { surveyPath, footerPath } = {}) {
  if (!surveyPath || !footerPath) throw new Error('固定尾图必须同时配置调研图与社群封底');
  return appendTailDescriptors(html, [
    {
      path: surveyPath,
      wrapperValue: 'survey',
      markerName: 'data-zen-final-survey',
      alt: 'Zen Trading 内容调研问卷',
    },
    {
      path: footerPath,
      wrapperValue: 'footer',
      markerName: 'data-zen-final-footer',
      alt: 'Zen Trading 社群',
    },
  ]);
}

function appendTailDescriptors(html, descriptors) {
  const dom = new JSDOM(`<body>${String(html || '')}</body>`);
  const document = dom.window.document;
  const root = document.body.children.length === 1 ? document.body.firstElementChild : document.body;

  for (const image of [...document.querySelectorAll('img')]) {
    const src = image.getAttribute('src') || '';
    const isFixedTail = descriptors.some(({ path: assetPath, markerName }) => (
      src === assetPath || image.getAttribute(markerName) === 'true'
    ));
    if (!isFixedTail) continue;
    const parent = image.parentElement;
    if (parent && parent !== root && parent.children.length === 1 && !parent.textContent.trim()) parent.remove();
    else image.remove();
  }

  const appended = descriptors.map((descriptor) => {
    const paragraph = document.createElement('p');
    paragraph.setAttribute('data-zen-final-tail-wrapper', descriptor.wrapperValue);
    if (descriptor.wrapperValue === 'footer') {
      paragraph.setAttribute('data-zen-final-footer-wrapper', 'true');
    }
    paragraph.setAttribute('style', 'font-size:0;line-height:0;margin:1em 0 0;padding:0;');
    const image = document.createElement('img');
    image.setAttribute('src', descriptor.path);
    image.setAttribute('alt', descriptor.alt);
    image.setAttribute(descriptor.markerName, 'true');
    image.setAttribute('style', 'max-width:100%;width:100%;height:auto;margin:0 auto;display:block;border:0;border-radius:.5em;');
    paragraph.appendChild(image);
    root.appendChild(paragraph);
    return paragraph;
  });

  const last = appended.at(-1);
  if (root.lastElementChild !== last || root.lastChild !== last) throw new Error('固定尾图最终节点校验失败');
  if (appended.length === 2 && last.previousElementSibling !== appended[0]) {
    throw new Error('固定尾图顺序校验失败');
  }
  return document.body.innerHTML;
}

export function stripFooterMarkdown(markdown, footerPath) {
  return stripFinalTailMarkdown(markdown, [footerPath]);
}

export function stripFinalTailMarkdown(markdown, assetPaths = []) {
  const paths = assetPaths.filter(Boolean);
  if (!paths.length) return String(markdown || '');
  return String(markdown || '')
    .split('\n')
    .filter((line) => !paths.some((assetPath) => line.includes(`](${assetPath})`)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function validateFinalTailOrder(document, { finalSurveyPath, finalFooterPath }) {
  if (!finalSurveyPath || !finalFooterPath) return ['固定尾图必须同时配置调研图与社群封底'];
  const surveyImages = [...document.querySelectorAll('[data-zen-final-survey="true"]')];
  const footerImages = [...document.querySelectorAll('[data-zen-final-footer="true"]')];
  const errors = [];
  if (surveyImages.length !== 1) errors.push(`固定调研图数量应为 1，实际为 ${surveyImages.length}`);
  if (footerImages.length !== 1) errors.push(`固定社群封底数量应为 1，实际为 ${footerImages.length}`);
  if (surveyImages[0]?.getAttribute('src') !== finalSurveyPath) errors.push('固定调研图路径不匹配');
  if (footerImages[0]?.getAttribute('src') !== finalFooterPath) errors.push('固定社群封底路径不匹配');
  if (errors.length) return errors;

  const surveyWrapper = surveyImages[0].closest('[data-zen-final-tail-wrapper="survey"]');
  const footerWrapper = footerImages[0].closest('[data-zen-final-tail-wrapper="footer"]');
  const root = document.body.children.length === 1 ? document.body.firstElementChild : document.body;
  if (!surveyWrapper || !footerWrapper) errors.push('固定尾图包装节点缺失');
  if (footerWrapper !== root.lastElementChild || footerWrapper !== root.lastChild) {
    errors.push('固定社群封底不是最终节点');
  }
  if (footerWrapper?.previousElementSibling !== surveyWrapper) {
    errors.push('固定调研图必须紧邻社群封底并位于其前');
  }
  return errors;
}
