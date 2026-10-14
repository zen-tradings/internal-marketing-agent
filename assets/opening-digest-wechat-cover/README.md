# Opening Digest WeChat cover assets

The wide 900×383 Canvas design and embedded logo/Montserrat font come from
[zentradings-cover](https://github.com/jfojellyfish-glitch/zentradings-cover)
at commit `61cda322a248c28c5a9dc9d9e97bd2120d399b68`.
`render.js` preserves that artwork without the editor UI. It renders one complete
headline and the fixed `TREASURY YIELDS · SOFTWARE · MARKET SIGNALS` line in two
variants that share this exact rendering: the WeChat Chinese draft cover
(`src/lib/opening-digest-wechat-cover.js`, 900×383, Chinese headline) and the
English email cover (`src/lib/opening-digest-email-cover.js`, integer `scale: 2`
that multiplies the canvas backing store under `ctx.scale` and outputs 1800×766
with the `DAILY BRIEF` section and the English headline).

Montserrat is the source's variable font (weights 100–900). Noto Sans SC is a
variable font bundled from the official Google Fonts repository, replacing the
source's host-dependent Chinese fallback. Both fonts are licensed under SIL OFL;
their license texts are included. The Chinese glyph shapes can differ slightly
from the original macOS preview, but no host-installed fonts are required.
Chromium reads the verified Chinese font directly from its bundled local file;
it is not expanded into a large base64 HTML message. Only the exact render file
and font path are allowed through the offline browser's resource filter.

`sources.json` records immutable source commits, source URLs and SHA-256 checksums.
The renderer validates the four runtime assets before reading its image cache.
When changing artwork or assets, update the manifest; the `assetVersion` hash then
invalidates both variants' caches and any WeChat template bump still follows the
draft template rules. Do not fetch fonts, images or code at runtime.
