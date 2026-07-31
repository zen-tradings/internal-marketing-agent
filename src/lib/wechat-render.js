import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { prepareRenderContext, publishToWechatDraft } from '@wenyan-md/core/wrapper';

export async function renderAndPublishWithFinalFooter(inputContent, options, getInputContent) {
  const { gzhContent, absoluteDirPath } = await prepareRenderContext(inputContent, options, getInputContent);
  if (!gzhContent?.title) throw new Error('未能找到文章标题');
  gzhContent.content = normalizeBodyTypography(
    styleKeyHighlights(alignTerminalReferences(removeDuplicateReferenceSections(gzhContent.content))),
  );
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
  const data = await publishToWechatDraft(gzhContent, { appId: options.appId, relativePath: absoluteDirPath });
  if (!data?.media_id) throw new Error(`发布到微信公众号失败:${JSON.stringify(data)}`);
  return data.media_id;
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
  const sourceInfoLabels = [...document.querySelectorAll('strong')]
    .filter((node) => node.textContent.trim() === '原文信息');
  if (sourceInfoLabels.length > 1) errors.push(`最终 HTML 含 ${sourceInfoLabels.length} 个“原文信息”板块`);
  const oversizedBodyNodes = [...document.querySelectorAll('p,li,blockquote')]
    .filter((node) => !node.closest('[data-zen-final-tail-wrapper]'))
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
    if (/^(?:https?:|data:|asset:|\/\/)/i.test(src)) continue;
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
  for (const quote of document.querySelectorAll('blockquote')) {
    quote.style.fontFamily = bodyFont;
    quote.style.fontSize = '.88em';
    quote.style.fontWeight = '300';
    quote.style.lineHeight = '1.6';
    for (const paragraph of quote.querySelectorAll('p')) {
      paragraph.style.fontFamily = bodyFont;
      paragraph.style.fontSize = '1em';
      paragraph.style.fontWeight = '300';
      paragraph.style.lineHeight = '1.6';
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
    if (bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
      return 'WebP';
    }
    if (/<svg(?:\s|>)/i.test(bytes.toString('utf8'))) return 'SVG';
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
