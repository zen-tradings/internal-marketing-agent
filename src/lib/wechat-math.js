import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { chromium } from 'playwright-core';
import { withRuntimeResource } from '../config/runtime.js';
import { resolveBrowserExecutable } from '../../tools/cover-generator/render.mjs';

// WeChat draft formulas must be rasterized images. The upstream wenyan-core pipeline
// runs MathJax over HTML that marked has already mangled (underscores in TeX become
// <em>), which fragments formulas, leaks raw LaTeX into body copy, and renders CJK
// fallback text that overlaps under WeChat's reader font scaling. This module
// protects math before markdown parsing (placeholders that survive marked intact),
// renders each formula to a 3x transparent PNG via the same MathJax + Chromium stack
// used for tables and heading cards, and restores validated <img> nodes afterwards.

export const MATH_TOKEN_RE = /ZENMATH\d{4}XZENMATH/g;
const MATH_TOKEN_ONE = /ZENMATH\d{4}XZENMATH/;
const MATH_TOKEN_PREFIX = 'ZENMATH';
const MATH_TOKEN_SUFFIX = 'XZENMATH';

export const MATH_INK_COLOR = '#2B3645';
export const MATH_CAPTURE_SCALE = 3;
const MATH_BASE_FONT_PX = 16;
// WeChat's editor drops em-valued width/height on <img>, so em sizing never
// reaches the reader and formulas render at their intrinsic 3x pixels (~3.5x
// the body font). Size images in integer px instead, scaled to the theme body
// font (.88em of a 16px reader base, matching #wenyan p in assets/zen-trading.css);
// the 3x PNG keeps rendering sharp at that smaller display size.
const MATH_BODY_FONT_EM = 0.88;
const MATH_DISPLAY_MARGIN_PX = Math.round(MATH_BODY_FONT_EM * MATH_BASE_FONT_PX);
const MATH_CAPTURE_PADDING = { x: 3, y: 2 };
const MAX_INLINE_TEX_LENGTH = 1000;
const MAX_DISPLAY_TEX_LENGTH = 4000;
// Bar-like glyphs (a lone bold minus is 0.136ex tall) have intrinsically thin
// bounding boxes, so MathJax itself certifies the render is correct. The
// plausible-size floor below targets broken renders of normal-sized formulas;
// intrinsically thin glyphs are allowed under it instead of hard-failing.
const TINY_INLINE_GLYPH_MAX_HEIGHT_EX = 0.5;
const TINY_DISPLAY_GLYPH_MAX_WIDTH_EX = 1.8;

const TEX_FEATURE_RE = /\\[a-zA-Z]+|[_^]\s*[{A-Za-z0-9]|\{/;
// Single variables ($t$, $N$, $W$, $x_i$) carry no TeX feature characters but are
// ubiquitous in math-heavy papers; a lone letter between delimiters is virtually
// never prose or currency, so extract it too.
const TEX_SINGLE_VARIABLE_RE = /^[A-Za-z](?:_[A-Za-z0-9])?$/;
const TEX_COMMAND_RE = /\\[a-zA-Z]{2,}/;
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const INLINE_CODE_RE = /`[^`\n]*`/g;

function mathToken(index) {
  return `${MATH_TOKEN_PREFIX}${String(index).padStart(4, '0')}${MATH_TOKEN_SUFFIX}`;
}

function isTeXLike(content) {
  return TEX_FEATURE_RE.test(content) || TEX_SINGLE_VARIABLE_RE.test(content);
}

function hasCJK(content) {
  return CJK_RE.test(content);
}

// A dollar preceded by an odd number of backslashes is an escaped literal $,
// not a math delimiter: $\textbf{Brier}_{\$}$ must close at the final $ only.
function unescapedDollarIndex(text, from) {
  let index = text.indexOf('$', from);
  while (index >= 0) {
    let slashes = 0;
    for (let p = index - 1; p >= 0 && text[p] === '\\'; p -= 1) slashes += 1;
    if (slashes % 2 === 0) return index;
    index = text.indexOf('$', index + 1);
  }
  return -1;
}

function maskInlineCode(line) {
  const holes = [];
  const masked = line.replace(INLINE_CODE_RE, (span) => {
    holes.push(span);
    return `\u0000${holes.length - 1}\u0000`;
  });
  return { masked, holes };
}

function unmaskInlineCode(text, holes) {
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => holes[Number(index)] ?? '');
}

function fenceState(line) {
  return /^\s{0,3}(?:```|~~~)/.test(line);
}

function extractFromSegment(segment, equations) {
  // Display math may span lines; extract it first so a later inline pass
  // cannot pair its dollar signs.
  let working = segment.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
    const trimmed = String(tex).trim();
    if (!trimmed || trimmed.length > MAX_DISPLAY_TEX_LENGTH || !isTeXLike(trimmed)) return match;
    const token = mathToken(equations.length + 1);
    equations.push({ token, tex: trimmed, display: true, hasCjk: CJK_RE.test(trimmed) });
    return `\n\n${token}\n\n`;
  });
  working = working.replace(/\\\[([\s\S]+?)\\\]/g, (match, tex) => {
    const trimmed = String(tex).trim();
    if (!trimmed || trimmed.length > MAX_DISPLAY_TEX_LENGTH) return match;
    const token = mathToken(equations.length + 1);
    equations.push({ token, tex: trimmed, display: true, hasCjk: CJK_RE.test(trimmed) });
    return `\n\n${token}\n\n`;
  });

  // Inline math stays within a single line so a stray dollar can never swallow
  // the next paragraph. Inline code spans are masked before scanning. Remaining
  // dollars and \(\) pairs (currency amounts, prose parens) are neutralized so
  // wenyan's own MathJax pass can never pair them into garbled formulas.
  const lines = working.split('\n').map((line) => {
    const { masked, holes } = maskInlineCode(line);
    const scanned = neutralizeStrayDelimiters(scanInlineMath(masked, equations));
    return unmaskInlineCode(scanned, holes);
  });
  return lines.join('\n');
}

// $...$ and \(...\) inline delimiters share single-line safety; scan the masked
// line for both openers so either syntax is protected.
function scanInlineMath(masked, equations) {
  let scanned = '';
  let cursor = 0;
  while (cursor < masked.length) {
    const dollar = masked.indexOf('$', cursor);
    const paren = masked.indexOf('\\(', cursor);
    const useParen = paren >= 0 && (dollar < 0 || paren < dollar);
    const opener = useParen ? paren : dollar;
    if (opener < 0) {
      scanned += masked.slice(cursor);
      break;
    }
    if (masked[opener - 1] === '\\') {
      scanned += masked.slice(cursor, opener + 1);
      cursor = opener + 1;
      continue;
    }
    let contentStart;
    let nextCursor;
    let closeIndex;
    if (useParen) {
      contentStart = opener + 2; // skip both characters of the \( opener
      closeIndex = masked.indexOf('\\)', contentStart);
      nextCursor = closeIndex < 0 ? -1 : closeIndex + 2;
    } else {
      contentStart = opener + 1;
      closeIndex = unescapedDollarIndex(masked, contentStart);
      nextCursor = closeIndex < 0 ? -1 : closeIndex + 1;
    }
    if (closeIndex < 0) {
      scanned += masked.slice(cursor);
      break;
    }
    const content = masked.slice(contentStart, closeIndex);
    const token = content.trim() && content.length <= MAX_INLINE_TEX_LENGTH && isTeXLike(content)
      ? mathToken(equations.length + 1)
      : undefined;
    if (token) {
      equations.push({ token, tex: content.trim(), display: false, hasCjk: CJK_RE.test(content) });
      scanned += masked.slice(cursor, opener) + token;
      cursor = nextCursor;
    } else {
      scanned += masked.slice(cursor, nextCursor);
      cursor = nextCursor;
    }
  }
  return scanned;
}

// MathJax only pairs delimiters within one text node, so each stray body-text
// dollar wrapped in its own span can never join another dollar into a formula.
// Visible output is unchanged. Stray \( \) pairs degrade to plain parentheses.
function neutralizeStrayDelimiters(masked) {
  const span = '<span data-zen-math-currency="true">$</span>';
  // Single pass: a second /\$/ pass would re-wrap the $ inside the span again.
  return masked
    .replace(/\\\(|\\\)/g, '(')
    .replace(/\\\$|\$/g, span);
}

// Extract $...$, $$...$$, \(...\), \[...\] formulas into placeholder tokens that
// survive the markdown renderer untouched. Code fences, inline code spans, and
// frontmatter are never touched; currency-like "$5 ... $10" pairs without TeX
// features keep their visible dollars, neutralized against MathJax pairing, so
// protection never garbles finance copy.
export function protectMathInMarkdown(markdown) {
  const source = String(markdown ?? '');
  const equations = [];
  const lines = source.split('\n');
  const output = [];
  let index = 0;

  // Skip YAML frontmatter; titles and metadata must not trigger math pairing.
  if (lines[0]?.trim() === '---') {
    output.push(lines[0]);
    index = 1;
    while (index < lines.length && lines[index].trim() !== '---') {
      output.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      output.push(lines[index]);
      index += 1;
    }
  }

  let inFence = false;
  const flushSegment = () => {
    if (!segment.length) return;
    output.push(extractFromSegment(segment.join('\n'), equations));
    segment = [];
  };
  let segment = [];
  while (index < lines.length) {
    const line = lines[index];
    if (fenceState(line)) {
      flushSegment();
      inFence = !inFence;
      output.push(line);
      index += 1;
      continue;
    }
    if (inFence) {
      output.push(line);
    } else {
      segment.push(line);
    }
    index += 1;
  }
  flushSegment();

  const protectedMarkdown = dedupeDisplayEquations(output.join('\n'), equations);

  return {
    markdown: protectedMarkdown,
    changed: equations.length > 0,
    equations,
  };
}

// Models often emit a numbered display equation twice: once as an inline-only
// paragraph and once as a $$ block with identical TeX. Dropping the inline copy
// keeps the centered display form without any content loss (直译不增不减).
function dedupeDisplayEquations(markdown, equations) {
  const byToken = new Map(equations.map((equation) => [equation.token, equation]));
  const normalize = (tex) => String(tex).replace(/\s+/g, '');
  let result = markdown.replace(/(ZENMATH\d{4}XZENMATH)\n{2,}(ZENMATH\d{4}XZENMATH)/g,
    (pair, inlineToken, displayToken) => {
      const inline = byToken.get(inlineToken);
      const display = byToken.get(displayToken);
      if (!inline || !display || inline.display || !display.display) return pair;
      if (normalize(inline.tex) !== normalize(display.tex)) return pair;
      byToken.delete(inlineToken);
      inline.deduped = true;
      return displayToken;
    });
  for (let index = equations.length - 1; index >= 0; index -= 1) {
    if (equations[index].deduped) equations.splice(index, 1);
  }
  return result;
}

function mathImagePx(cssPixels) {
  return Math.max(1, Math.round(cssPixels * MATH_BODY_FONT_EM));
}

function buildEquationImage(document, equation) {
  const image = equation.image;
  if (!image?.src) throw new Error(`公式 ${equation.token} 缺少渲染图片`);
  const width = mathImagePx(image.width);
  const height = mathImagePx(image.height);
  const node = document.createElement('img');
  node.setAttribute('src', image.src);
  node.setAttribute('data-zen-math', 'true');
  node.setAttribute('alt', '');
  // Integer width/height attributes mirror the px style so the display size
  // survives even if WeChat strips the style attribute entirely.
  node.setAttribute('width', String(width));
  node.setAttribute('height', String(height));
  const style = equation.display
    ? `width:${width}px;height:auto;max-width:100%;margin:${MATH_DISPLAY_MARGIN_PX}px auto;display:block;`
    : `width:${width}px;height:${height}px;vertical-align:middle;max-width:100%;`;
  node.setAttribute('style', style);
  return node;
}

// Replace protection tokens in the styled HTML with rasterized equation images.
// Inline formulas are sized in integer px matched to the theme body font (WeChat
// ignores em sizes on images); display formulas stay centered and clamp to the
// article width.
export function restoreMathInHtml(html, { equations = [] } = {}) {
  if (!equations.length) return String(html ?? '');
  const byToken = new Map(equations.map((equation) => [equation.token, equation]));
  const dom = new JSDOM(`<body>${String(html ?? '')}</body>`);
  const window = dom.window;
  const walker = window.document.createTreeWalker(window.document.body, window.NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (MATH_TOKEN_ONE.test(walker.currentNode.nodeValue)) targets.push(walker.currentNode);
  }
  for (const node of targets) {
    const parts = node.nodeValue.split(/(ZENMATH\d{4}XZENMATH)/);
    const fragment = window.document.createDocumentFragment();
    for (const part of parts) {
      const equation = byToken.get(part);
      if (!equation) {
        if (part) fragment.appendChild(window.document.createTextNode(part));
        continue;
      }
      if (equation.display) {
        const section = window.document.createElement('section');
        section.setAttribute('data-zen-math-display', 'true');
        section.setAttribute('style', 'text-align:center;margin:1em 0;');
        section.appendChild(buildEquationImage(window.document, equation));
        fragment.appendChild(section);
      } else {
        fragment.appendChild(buildEquationImage(window.document, equation));
      }
    }
    node.parentNode.replaceChild(fragment, node);
  }
  return window.document.body.innerHTML;
}

// Hard gate: every protected formula must come back as exactly one image, and no
// placeholder, MathJax artifact, or raw TeX command may remain in body copy.
export function validateMathRestored(html, { equations = [] } = {}) {
  const errors = [];
  const document = new JSDOM(`<body>${String(html ?? '')}</body>`).window.document;
  const residue = document.body.textContent.match(MATH_TOKEN_RE);
  if (residue?.length) {
    errors.push(`最终 HTML 残留 ${new Set(residue).size} 个未恢复的公式占位符`);
  }
  const images = [...document.querySelectorAll('img[data-zen-math="true"]')];
  if (images.length !== equations.length) {
    errors.push(`公式图片恢复数量不符:提取 ${equations.length} 个,恢复 ${images.length} 个`);
  }
  // Plausible rendered-size bounds catch sizing regressions (e.g. a stray em
  // that WeChat discards, or a 3x intrinsic-size fallback) before a draft with
  // invisible or oversized formulas can be published. The width/height
  // attributes must mirror the px style so the size survives even if WeChat
  // strips one of the two carriers.
  const readStylePx = (image, property) => {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i')
      .exec(image.getAttribute('style') || '');
    return match ? Number(match[1]) : Number.NaN;
  };
  const readAttributePx = (image, property) => {
    const raw = image.getAttribute(property);
    return /^\d+$/.test(raw || '') ? Number(raw) : Number.NaN;
  };
  for (const [index, image] of images.entries()) {
    const isDisplay = Boolean(image.getAttribute('data-zen-math-display') || image.closest('[data-zen-math-display]'));
    const primary = isDisplay ? 'width' : 'height';
    const minPx = isDisplay ? 12 : 5;
    const maxPx = isDisplay ? 640 : 120;
    // Intrinsically thin glyphs (tinyGlyph, certified by MathJax's own ex
    // metrics at compile time) legitimately capture below the floor; any other
    // sub-floor render still indicates a broken capture.
    const equation = images.length === equations.length ? equations[index] : null;
    const floorPx = equation?.image?.tinyGlyph ? 1 : minPx;
    const stylePx = readStylePx(image, primary);
    if (Number.isNaN(stylePx)) {
      errors.push(`第 ${index + 1} 张公式图片缺少 ${primary} px 尺寸`);
    } else if (stylePx < floorPx || stylePx > maxPx) {
      errors.push(`第 ${index + 1} 张${isDisplay ? '显示' : '行内'}公式 ${primary} ${stylePx}px 超出合理范围`);
    }
    const mismatches = ['width', 'height'].filter((property) => {
      const attrPx = readAttributePx(image, property);
      if (Number.isNaN(attrPx)) return true;
      const styleValue = readStylePx(image, property);
      return !Number.isNaN(styleValue) && attrPx !== styleValue;
    });
    if (mismatches.length) {
      errors.push(`第 ${index + 1} 张公式图片 ${mismatches.join('/')} 属性缺失或与 px 尺寸不一致`);
    }
  }
  for (const [index, image] of images.entries()) {
    if (!image.getAttribute('src')) errors.push(`第 ${index + 1} 张公式图片缺少 src`);
  }
  if (document.querySelector('mjx-container')) {
    errors.push('最终 HTML 残留 MathJax 渲染容器,公式必须为图片');
  }
  if ([...document.querySelectorAll('svg')].some((svg) => svg.querySelector('[data-mml-node="math"]'))) {
    errors.push('最终 HTML 残留 MathJax 公式 SVG,公式必须为图片');
  }
  const texResidue = [];
  const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (parent?.closest('pre,code,[data-zen-math]')) continue;
    const match = TEX_COMMAND_RE.exec(walker.currentNode.nodeValue || '');
    if (match) texResidue.push(match[0]);
  }
  if (texResidue.length) {
    errors.push(`正文残留未渲染的 TeX 命令:${[...new Set(texResidue)].slice(0, 5).join(' ')}`);
  }
  if (errors.length) throw new Error(`公式渲染完整性校验失败:${errors.join('; ')}`);
  return { equations: equations.length, images: images.length };
}

// ---- Offline MathJax TeX -> SVG compilation (same packages as wenyan-core) ----

let mathJaxState;
function ensureMathJax() {
  if (mathJaxState) return mathJaxState;
  const adaptor = liteAdaptor({ fontSize: MATH_BASE_FONT_PX });
  try {
    RegisterHTMLHandler(adaptor);
  } catch {
    // wenyan-core registers its own lite adaptor per process; either instance
    // serializes identically, so a duplicate registration is harmless.
  }
  const texJax = new TeX({
    inlineMath: [['\\(', '\\)']],
    displayMath: [['\\[', '\\]']],
    processEscapes: false,
    packages: AllPackages,
  });
  const svgJax = new SVG({ fontCache: 'none' });
  mathJaxState = { texJax, svgJax };
  return mathJaxState;
}

export function compileEquationSvg(tex, display) {
  const { texJax, svgJax } = ensureMathJax();
  const source = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  const doc = mathjax.document(source, { InputJax: texJax, OutputJax: svgJax });
  doc.render();
  const adaptor = doc.adaptor;
  const html = adaptor.innerHTML(adaptor.body(doc.document));
  // Unknown macros render as red mtext (fill="red") in SVG output; merror covers
  // other compile failures. Either means the formula would publish broken glyphs.
  const error = /data-mjx-error="([^"]*)"/.exec(html);
  if (error || html.includes('<merror') || /fill="red"/.test(html)) {
    throw new Error(`公式编译失败:${error?.[1] || 'MathJax 无法识别的命令或语法错误'}`);
  }
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0];
  if (!svg) throw new Error(`公式编译未产出 SVG:${String(tex).slice(0, 80)}`);
  return {
    svg,
    widthEx: Number(/width="([\d.]+)ex"/.exec(svg)?.[1]) || 0,
    heightEx: Number(/height="([\d.]+)ex"/.exec(svg)?.[1]) || 0,
  };
}

export function equationCaptureHtml(svg, color = MATH_INK_COLOR) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font-size:${MATH_BASE_FONT_PX}px}
body{font-family:Georgia,"Times New Roman","Songti SC",serif}
.wrap{display:inline-block;padding:${MATH_CAPTURE_PADDING.y}px ${MATH_CAPTURE_PADDING.x}px;color:${color}}
.wrap svg{display:block}
</style></head><body><div class="wrap">${svg}</div></body></html>`;
}

async function captureEquationsWithBrowser(items, { outDir, executablePath, color, signal }) {
  const browserPath = executablePath || resolveBrowserExecutable();
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 2400, height: 400 },
      deviceScaleFactor: MATH_CAPTURE_SCALE,
    });
    const results = [];
    for (const [index, item] of items.entries()) {
      const src = `math-${String(index + 1).padStart(3, '0')}.png`;
      const outPath = path.join(outDir, src);
      await page.setContent(equationCaptureHtml(item.svg, color), { waitUntil: 'load' });
      const box = await page.locator('.wrap').boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error(`公式 ${index + 1} 截图尺寸无效`);
      }
      await page.locator('.wrap').screenshot({
        path: outPath,
        type: 'png',
        omitBackground: true,
        animations: 'disabled',
      });
      results.push({
        src,
        path: outPath,
        width: Math.ceil(box.width - MATH_CAPTURE_PADDING.x * 2),
        height: Math.ceil(box.height - MATH_CAPTURE_PADDING.y * 2),
      });
    }
    return results;
  } finally {
    await browser?.close();
  }
}

// Render every unique formula to a 3x transparent PNG under the run directory.
// Identical TeX reuses one file. MathJax compilation errors hard-fail the task.
export async function renderEquationPngs(equations, {
  outDir,
  executablePath,
  signal,
  color = MATH_INK_COLOR,
  capture = captureEquationsWithBrowser,
} = {}) {
  const list = Array.isArray(equations) ? equations.filter(Boolean) : [];
  if (!list.length) return [];
  if (!outDir) throw new Error('公式图片渲染缺少输出目录');

  const groups = new Map();
  for (const equation of list) {
    if (!equation?.token || typeof equation.tex !== 'string' || !equation.tex.trim()) {
      throw new Error(`公式 ${equation?.token || '?'} 缺少 TeX 内容`);
    }
    const key = `${equation.display ? 'block' : 'inline'}::${equation.tex}`;
    let group = groups.get(key);
    if (!group) {
      group = { tex: equation.tex, display: Boolean(equation.display), members: [] };
      groups.set(key, group);
    }
    group.members.push(equation);
  }

  const compiled = [];
  for (const group of groups.values()) {
    const { svg, widthEx, heightEx } = compileEquationSvg(group.tex, group.display);
    const tinyGlyph = group.display
      ? widthEx <= TINY_DISPLAY_GLYPH_MAX_WIDTH_EX
      : heightEx <= TINY_INLINE_GLYPH_MAX_HEIGHT_EX;
    compiled.push({ ...group, svg, tinyGlyph });
  }

  const captured = await withRuntimeResource(
    'browser',
    () => capture(compiled, { outDir, executablePath, signal, color }),
    signal,
  );
  if (!Array.isArray(captured) || captured.length !== compiled.length) {
    throw new Error('公式截图数量与公式数量不一致');
  }
  compiled.forEach((group, index) => {
    const image = captured[index];
    if (!image?.src || !(image.width > 0) || !(image.height > 0)) {
      throw new Error(`公式 ${index + 1} 截图结果无效`);
    }
    for (const member of group.members) {
      member.image = { src: image.src, width: image.width, height: image.height, tinyGlyph: group.tinyGlyph };
    }
  });
  return list;
}
