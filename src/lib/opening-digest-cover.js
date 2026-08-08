import { chromium } from 'playwright-core';

export const OPENING_COVER_WIDTH = 1240;
export const OPENING_COVER_HEIGHT = 620;

export async function renderOpeningDigestCover({ dateLabel, executablePath, timeoutMs = 30000 }) {
  if (!executablePath) throw coverError('缺少 OPENING_DIGEST_BROWSER_EXECUTABLE');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: OPENING_COVER_WIDTH, height: OPENING_COVER_HEIGHT }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(coverHtml(dateLabel), { waitUntil: 'load' });
    return Buffer.from(await page.screenshot({ type: 'png', omitBackground: false }));
  } finally { await browser.close(); }
}

export function coverHtml(dateLabel) {
  const safeDate = escapeHtml(dateLabel);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{width:1240px;height:620px;margin:0;overflow:hidden}
    body{position:relative;color:#f5f4ef;background:radial-gradient(circle at 12% 22%,#112f53 0%,#061426 33%,#030913 100%);font-family:Arial,Helvetica,sans-serif}
    body:before,body:after{content:"";position:absolute;inset:-10%;background-image:radial-gradient(#d9eaff 1px,transparent 1.5px),radial-gradient(#91d5ff 1px,transparent 1.5px);background-size:71px 71px,113px 113px;background-position:0 0,35px 48px;opacity:.55}
    .line{position:absolute;height:1px;background:#2a7096;opacity:.55;transform-origin:left}.l1{top:74px;left:88px;width:196px;transform:rotate(-28deg)}.l2{top:78px;right:92px;width:224px;transform:rotate(22deg)}.l3{bottom:84px;left:55px;width:245px;transform:rotate(26deg)}.l4{bottom:74px;right:42px;width:218px;transform:rotate(-25deg)}
    .brand{position:absolute;top:118px;left:0;right:0;text-align:center;letter-spacing:.28em;font-size:34px;font-weight:500}.mark{display:inline-block;margin-right:28px;font-style:italic;font-size:50px;letter-spacing:-.2em;transform:rotate(-12deg);vertical-align:middle}.date{position:absolute;top:205px;left:0;right:0;text-align:center;font-size:17px;letter-spacing:.38em}.title{position:absolute;top:287px;left:0;right:0;text-align:center;font-size:64px;font-weight:300;letter-spacing:.015em}.tags{position:absolute;bottom:96px;left:0;right:0;text-align:center;font-size:17px;letter-spacing:.22em}.dot{color:#7ad9ff;padding:0 17px}
  </style></head><body><i class="line l1"></i><i class="line l2"></i><i class="line l3"></i><i class="line l4"></i><div class="brand"><span class="mark">ZT</span>ZEN TRADING</div><div class="date">OPENING DIGEST <span class="dot">/</span> ${safeDate}</div><div class="title">Zen Research from Zen Trading</div><div class="tags">EARNINGS <span class="dot">•</span> SUPPLY CHAINS <span class="dot">•</span> CATALYSTS <span class="dot">•</span> MARKET SIGNALS</div></body></html>`;
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function coverError(message) { const error = new Error(message); error.stage = 'cover'; return error; }
