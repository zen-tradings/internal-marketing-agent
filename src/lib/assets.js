import fs from 'node:fs';

// 把仓库固定的头图/尾图注入文章 markdown。幂等:markdown 中已含对应绝对路径字符串时不重复插入。
// 路径原样写入(不做 URL 编码),因为 wenyan 按本地文件读取上传,含空格的路径一旦编码成 %20 会读取失败。
export function injectFixedImages(markdown, { headerPath, footerPath, existsFn = fs.existsSync } = {}) {
  const skipped = [];
  let out = markdown;

  if (headerPath) {
    if (!existsFn(headerPath)) {
      skipped.push(headerPath);
    } else if (!out.includes(headerPath)) {
      const headerLine = `![Zen Trading](${headerPath})`;
      const fmMatch = out.match(/^---\n[\s\S]*?\n---/);
      if (fmMatch) {
        const end = fmMatch[0].length;
        const rest = out.slice(end).replace(/^\n+/, '');
        out = `${out.slice(0, end)}\n\n${headerLine}\n\n${rest}`;
      } else {
        out = `${headerLine}\n\n${out}`;
      }
    }
  }

  if (footerPath) {
    if (!existsFn(footerPath)) {
      skipped.push(footerPath);
    } else if (!out.includes(footerPath)) {
      const footerLine = `![Zen Trading 社群](${footerPath})`;
      out = `${out.replace(/\n+$/, '')}\n\n${footerLine}\n`;
    }
  }

  return { markdown: out, skipped };
}
