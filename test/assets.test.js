import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectFixedImages } from '../src/lib/assets.js';

const HEADER = '/repo/assets/zen-header-banner.gif';
const FOOTER = '/repo/assets/zen-footer-qr.png';
const alwaysExists = () => true;

test('有 frontmatter 时头图插在第二个 --- 之后空一行处,尾图追加到文末', () => {
  const md = '---\ntitle: T\n---\n正文第一行。';
  const { markdown, skipped } = injectFixedImages(md, { headerPath: HEADER, footerPath: FOOTER, existsFn: alwaysExists });
  assert.deepEqual(skipped, []);
  assert.match(markdown, /^---\ntitle: T\n---\n\n!\[Zen Trading\]\(\/repo\/assets\/zen-header-banner\.gif\)\n\n正文第一行。/);
  assert.match(markdown, /!\[Zen Trading 社群\]\(\/repo\/assets\/zen-footer-qr\.png\)\n?$/);
  // 头图应在正文之前,尾图在正文之后
  assert.ok(markdown.indexOf(HEADER) < markdown.indexOf('正文第一行'));
  assert.ok(markdown.indexOf(FOOTER) > markdown.indexOf('正文第一行'));
});

test('无 frontmatter 时头图插在最开头,尾图仍追加到文末', () => {
  const md = '正文,没有 frontmatter。';
  const { markdown, skipped } = injectFixedImages(md, { headerPath: HEADER, footerPath: FOOTER, existsFn: alwaysExists });
  assert.deepEqual(skipped, []);
  assert.match(markdown, /^!\[Zen Trading\]\(\/repo\/assets\/zen-header-banner\.gif\)\n\n正文/);
  assert.match(markdown, /!\[Zen Trading 社群\]\(\/repo\/assets\/zen-footer-qr\.png\)\n?$/);
});

test('幂等:markdown 已含 headerPath 字符串时不重复插入头图', () => {
  const md = `---\ntitle: T\n---\n\n![Zen Trading](${HEADER})\n\n正文`;
  const { markdown } = injectFixedImages(md, { headerPath: HEADER, footerPath: undefined, existsFn: alwaysExists });
  const count = markdown.split(HEADER).length - 1;
  assert.equal(count, 1);
});

test('幂等:markdown 已含 footerPath 字符串时不重复插入尾图', () => {
  const md = `---\ntitle: T\n---\n正文\n\n![Zen Trading 社群](${FOOTER})\n`;
  const { markdown } = injectFixedImages(md, { headerPath: undefined, footerPath: FOOTER, existsFn: alwaysExists });
  const count = markdown.split(FOOTER).length - 1;
  assert.equal(count, 1);
});

test('文件不存在时跳过注入,返回 skipped 列出缺失路径,markdown 不含该图', () => {
  const md = '---\ntitle: T\n---\n正文';
  const missingHeader = '/no/such/header.gif';
  const missingFooter = '/no/such/footer.png';
  const { markdown, skipped } = injectFixedImages(md, {
    headerPath: missingHeader,
    footerPath: missingFooter,
    existsFn: () => false,
  });
  assert.deepEqual(skipped.sort(), [missingFooter, missingHeader].sort());
  assert.doesNotMatch(markdown, /missing-header|no\/such/);
  assert.equal(markdown, md);
});

test('只有其中一张图缺失时,存在的那张仍正常注入,skipped 只列缺失的一张', () => {
  const md = '---\ntitle: T\n---\n正文';
  const { markdown, skipped } = injectFixedImages(md, {
    headerPath: HEADER,
    footerPath: '/no/such/footer.png',
    existsFn: (p) => p === HEADER,
  });
  assert.deepEqual(skipped, ['/no/such/footer.png']);
  assert.match(markdown, new RegExp(`!\\[Zen Trading\\]\\(${HEADER.replace(/\//g, '\\/')}\\)`));
  assert.doesNotMatch(markdown, /Zen Trading 社群/);
});

test('路径原样写入,不做 URL 编码(路径含空格)', () => {
  const spacedHeader = '/repo/assets with space/zen-header-banner.gif';
  const md = '---\ntitle: T\n---\n正文';
  const { markdown, skipped } = injectFixedImages(md, { headerPath: spacedHeader, footerPath: undefined, existsFn: alwaysExists });
  assert.deepEqual(skipped, []);
  assert.match(markdown, /!\[Zen Trading\]\(\/repo\/assets with space\/zen-header-banner\.gif\)/);
  assert.doesNotMatch(markdown, /%20/);
});

test('未传 headerPath/footerPath 时不注入也不报 skipped', () => {
  const md = '---\ntitle: T\n---\n正文';
  const { markdown, skipped } = injectFixedImages(md, {});
  assert.equal(markdown, md);
  assert.deepEqual(skipped, []);
});

test('默认 existsFn 为 fs.existsSync,真实存在的文件可正常注入', () => {
  // 仓库自带这两张固定图,用真实路径验证默认 existsFn 行为(不传 existsFn)
  const path = new URL('../assets/zen-header-banner.gif', import.meta.url).pathname;
  const md = '---\ntitle: T\n---\n正文';
  const { markdown, skipped } = injectFixedImages(md, { headerPath: path });
  assert.deepEqual(skipped, []);
  assert.ok(markdown.includes(path));
});
