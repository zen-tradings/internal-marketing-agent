# Opening Digest WeChat cover assets

The wide 900×383 Canvas design and embedded logo/Montserrat font come from
[zentradings-cover](https://github.com/jfojellyfish-glitch/zentradings-cover)
at commit `61cda322a248c28c5a9dc9d9e97bd2120d399b68`.
`render.js` preserves that artwork without the editor UI. It renders one complete
Chinese headline and the fixed `TREASURY YIELDS · SOFTWARE · MARKET SIGNALS` line.

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
When changing artwork or assets, update the manifest and bump the fixed WeChat
Opening Digest template version. Do not fetch fonts, images or code at runtime.
