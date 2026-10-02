// Adapted from zentradings-cover/index.html at 61cda322a248c28c5a9dc9d9e97bd2120d399b68.
// The original wide Canvas artwork is retained; the Chinese headline is one centered phrase.
async function renderZenOpeningCover(data) {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 52;
  const brandFont = "'Zen Montserrat'";
  const textFont = "'Zen Montserrat', 'Zen Noto Sans SC'";
  await Promise.all([
    document.fonts.load(`300 62px ${brandFont}`, data.dateLabel),
    document.fonts.load(`600 15px ${brandFont}`, 'ZEN TRADING'),
    document.fonts.load(`500 28px 'Zen Noto Sans SC'`, data.headline + data.section),
  ]);
  await document.fonts.ready;
  if (!document.fonts.check(`300 62px ${brandFont}`, data.dateLabel)
      || !document.fonts.check(`500 28px 'Zen Noto Sans SC'`, data.headline + data.section)) {
    throw new Error('微信日报封面字体加载失败');
  }
  const logo = new Image();
  logo.src = data.logoDataUrl;
  await logo.decode();
  if (logo.naturalWidth !== 512 || logo.naturalHeight !== 512) throw new Error('微信日报封面 Logo 尺寸无效');

  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#0E1932'); gradient.addColorStop(.55, '#0a1732'); gradient.addColorStop(1, '#121D39');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * .75, h * .28, 0, w * .75, h * .28, w * .56);
  glow.addColorStop(0, 'rgba(64,105,172,.18)'); glow.addColorStop(1, 'rgba(8,16,36,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 86; i++) {
    ctx.beginPath();
    ctx.arc((Math.sin(i * 91.7) * .5 + .5) * w, (Math.sin(i * 37.1 + 2) * .5 + .5) * h, .35 + (i % 5) * .22, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(210,226,250,${.18 + (i % 7) * .075})`; ctx.fill();
  }
  ctx.strokeStyle = 'rgba(136,169,218,.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(w * .06, h * .83);
  ctx.bezierCurveTo(w * .32, h * .55, w * .58, h * .96, w * .94, h * .62); ctx.stroke();

  const size = h * .095;
  ctx.font = `600 ${Math.max(14, h * .038)}px ${brandFont}`; ctx.letterSpacing = '4px';
  const textWidth = ctx.measureText('ZEN TRADING').width + 40;
  const logoX = (w - (size + 18 + textWidth)) / 2;
  ctx.drawImage(logo, logoX, pad, size, size);
  ctx.fillStyle = 'rgba(238,244,253,.92)'; ctx.textAlign = 'left';
  ctx.fillText('ZEN TRADING', logoX + size + 18, pad + size * .64); ctx.letterSpacing = '0px';

  ctx.textAlign = 'center';
  ctx.fillStyle = '#91a7c9'; ctx.font = `500 14px ${textFont}`;
  ctx.fillText(data.section, w / 2, 154);
  ctx.fillStyle = '#eef4ff'; ctx.font = `300 62px ${brandFont}`;
  ctx.fillText(data.dateLabel, w / 2, 224);
  let headlineSize = 28;
  const maxWidth = w - pad * 2;
  ctx.font = `500 ${headlineSize}px ${textFont}`;
  while (headlineSize > 18 && ctx.measureText(data.headline).width > maxWidth) {
    headlineSize--; ctx.font = `500 ${headlineSize}px ${textFont}`;
  }
  const headlineWidth = ctx.measureText(data.headline).width;
  if (headlineWidth > maxWidth) throw new Error('微信日报封面标题超出安全宽度');
  ctx.fillStyle = '#f1f5fc'; ctx.fillText(data.headline, w / 2, 287);
  ctx.fillStyle = '#7f95b7'; ctx.font = `500 11px ${brandFont}`;
  const tagsWidth = ctx.measureText(data.englishTags).width;
  if (tagsWidth > maxWidth) throw new Error('微信日报封面英文标签超出安全宽度');
  ctx.fillText(data.englishTags, w / 2, h - 37);
  return { headline: data.headline, headlineSize, headlineWidth, tagsWidth, maxWidth };
}
