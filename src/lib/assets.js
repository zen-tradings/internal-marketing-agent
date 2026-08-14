import fs from 'node:fs';

// Generic fixed-image Markdown helper with optional header/footer support. Production WeChat injects only headers;
// wechat-render.js appends the research-survey and community-footer images in final HTML order.
// Idempotent: do not insert an absolute path that is already present in Markdown.
// Keep paths unencoded because Wenyan uploads local files; encoding spaces as %20 prevents reads.
export function injectFixedImages(markdown, { headerPath, footerPath, existsFn = fs.existsSync } = {}) {
  const skipped = [];
  let out = markdown;

  if (headerPath) {
    if (!pathExists(headerPath, existsFn)) {
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
    if (!pathExists(footerPath, existsFn)) {
      skipped.push(footerPath);
    } else if (!out.includes(footerPath)) {
      const footerLine = `![Zen Trading 社群](${footerPath})`;
      out = `${out.replace(/\n+$/, '')}\n\n${footerLine}\n`;
    }
  }

  return { markdown: out, skipped };
}

function pathExists(value, existsFn) {
  if (existsFn(value)) return true;
  // URL.pathname encodes non-ASCII characters. Keep the original text in
  // Markdown, but probe the decoded filesystem form for local fixtures and
  // real paths copied from file URLs.
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== value && existsFn(decoded);
  } catch { return false; }
}
