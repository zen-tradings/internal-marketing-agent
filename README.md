# Zen Content Hub

Zen Content Hub is a single-instance, long-running content orchestration service. Users assign tasks in natural language through Slack, and the service routes them to a QDII data reply, a WeChat Official Account draft, or a Customer.io Newsletter draft. It supports local development on macOS and 24/7 production operation under systemd on Linux/DigitalOcean.

## Pipeline

```text
Slack direct-message prompt / channel @Bot / PDF or text attachment / cron
  → message/edit debounce, revision deduplication, SQLite enqueue, single-instance concurrency control
  → translation: scope detection → structured HTML/PDF → chunked translation and integrity gates
  → WeChat Analysis V2: original prompt → TaskContract → SearchPlan → EvidenceMatrix → evidence-led editorial brief
  → user PDF/Notion/Google Docs/GitHub/URL + latest primary sources + preferred sources + open cross-checking
  → general tasks use the LatePost method; macro tasks combine Global Macro leadership with LatePost evidence discipline
  → general copy uses Qwen3.8-Max; Opening Digest English copy uses GPT-OSS 120B → GLM 5.2 sentence-level fact audit → deterministic citations
  → central template gate → fixed WeChat layout / fixed Customer.io Newsletter template
  → ordinary channels create drafts only; `opening-digest` is the controlled send/schedule exception and may create a Chinese WeChat draft after email succeeds
  → QDII uses Slack replies as the primary result; failed terminal notifications enter the SQLite outbox for idempotent delivery after reconnection
```

Node.js controls the pipeline. `OPENROUTER_MODEL` in `.env` selects the general writing model; production defaults to `qwen/qwen3.8-max`. `OPENING_DIGEST_MODEL` may independently override the English Opening Digest model and uses `openai/gpt-oss-120b` in production. It falls back to `OPENROUTER_MODEL` when unset, while Chinese WeChat translation continues to use the general writing model.

`OPENROUTER_ROUTER_MODEL`, `OPENROUTER_PLANNER_MODEL`, and `OPENROUTER_REVIEW_MODEL` control routing, top-level task/evidence planning, and sentence-level fact review. Production uses `moonshotai/kimi-k3` for planning and direction, and GLM 5.2 for routing, auditing, and Opening Digest compression. Role models inherit the general model when not set separately. `OPENROUTER_REASONING_EFFORT` and each role-specific `*_REASONING_EFFORT` are independent: body writing and Kimi planning use `high`; GLM routing and review use `none`. `OPENROUTER_MAX_TOKENS` is the shared reasoning-plus-output budget for each request.

Versioned writing skills are loaded from this repository and injected at runtime; they are not tied to a specific model. Exa is used only for search and content retrieval. `alphaxiv.org` is a built-in preferred search domain; this project does not connect to AlphaXiv MCP.

## Repository layout

```text
src/
├── index.js                 Service entry point and dependency assembly
├── config/index.js          Environment configuration
├── core/                    Queue, SQLite, research/writing, notifications
├── triggers/                Slack and cron triggers
├── workflows/               Article types, prompts, preferred sources
├── channels/                WeChat, Customer.io, and mock draft channels
└── lib/                     Gates, fixed images, covers, rendering input

skills/
├── latepost-ai-writer/      Versioned Chinese AI/business/technology writing method, archetypes, and checklist
└── global-macro-strategy-writer/  Cross-asset macro method, three archetypes, and 368-sample index

scripts/
├── install-launchd.sh       Install the local persistent service
├── uninstall-launchd.sh     Uninstall the local persistent service
├── status.mjs               Inspect task status
├── research-trace.mjs       Inspect Exa queries and selected sources
├── check-openrouter.mjs     Validate OpenRouter configuration
├── check-egress.mjs         Read-only external API connectivity checks
├── check-customerio.mjs     Read-only Newsletter audience and remote-state checks
├── check-translation.mjs    Generate a local structured-translation acceptance draft
├── requeue-translation.mjs  Safely recover failed translations with checkpoints
├── requeue-analysis-gate.mjs Safely recover V2 analyses blocked by legacy code gates
├── check-documents.mjs      Read-only private Notion / Google Docs acceptance checks
├── google-docs-oauth.mjs    Generate a local Google Docs refresh token
├── auth-oic-session.mjs     Refresh the Opening Digest OIC browser session
├── run-opening-digest-acceptance.mjs Run isolated Opening Digest production acceptance
├── run-macro-acceptance.mjs Run local macro acceptance
├── deploy-digitalocean.mjs  Run DigitalOcean preflight and immutable deployment
├── preview-newsletter.mjs   Generate a local Newsletter HTML preview
└── update-render-golden.mjs Update rendering golden files

deploy/
├── zen-content-hub.service Linux systemd service template
├── zen-content-hub-backup* SQLite/runtime-asset backup script, unit, and timer
└── README.md               DigitalOcean deployment, update, and backup guide
```

See [`docs/GUIDE.md`](docs/GUIDE.md) for a more detailed code map.

## Installation and configuration

The service requires Node.js 22 or later plus OpenRouter, Slack, and WeChat Official Account credentials. QDII queries also require Python 3.11+. Original analysis requires Exa; translation does not. Local text extraction from analytical PDFs requires Poppler's `pdfinfo` and `pdftotext`. Scanned-document OCR and structure-preserving PDF translation require Datalab. Newsletter workflows also require a Customer.io App API key.

The Slack App must include `files:read` in its Bot Token Scopes. Without it, message events still include PDF names and private URLs, but downloads return the Slack login page. After adding the scope, reinstall the App in the workspace and update the production `SLACK_BOT_TOKEN`. The service validates the real PDF signature before invoking Poppler or Datalab and reports the permission issue instead of misclassifying login HTML as a damaged PDF.

```bash
npm ci
npm run setup:qdii
cp .env.example .env
```

After populating `.env`, run:

```bash
npm run check
npm run check:openrouter
npm run check:earnings-calendar
```

`check:earnings-calendar` performs a live Yahoo/yfinance earnings-calendar connectivity and schema check. It is not part of the default offline `npm run check`.

The service does not restrict public IP addresses, maintain an egress-IP allowlist, or block startup, research, or publishing because an IP changed, an IP lookup failed, or proxy variables are present. External requests use the host and Node.js runtime's normal network configuration. Real DNS, TLS, timeout, and target-API failures remain ordinary network errors. `npm run check:egress` is a read-only connectivity check and is not a runtime gate.

## Running the service

Start directly:

```bash
npm start
```

A safe rehearsal performs real research and writing without creating a WeChat draft:

```bash
HUB_DRY_RUN=1 npm start
```

Run persistently on macOS:

```bash
scripts/install-launchd.sh
launchctl print gui/$(id -u)/com.zentrading.content-hub | head
tail -f ~/Library/Logs/zen-content-hub/out.log
```

Restart after code or `.env` changes:

```bash
launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub
```

Do not run a launchd instance and a manual instance at the same time; they would consume Slack messages twice.

### Persistent Linux / DigitalOcean service

The repository includes a systemd service template, minimum directory layout, health checks, updates, and SQLite/runtime-asset recovery-unit backups. See [`deploy/README.md`](deploy/README.md). The recommended locations are `/opt/zen-content-hub` for code, `/var/lib/zen-content-hub` for runtime data, and `/etc/zen-content-hub/zen-content-hub.env` for secrets.

Health endpoints are disabled by default. Enable them with `HEALTH_HOST=127.0.0.1` and `HEALTH_PORT=8787`:

```bash
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
```

`/health` means the process and local state are readable. `/ready` additionally requires an active Slack Socket Mode connection. A transient Slack outage does not block persisted tasks: success, failure, cancellation, clarification, and core QDII replies enter the SQLite outbox and are delivered according to the task's current terminal state after reconnection. Stale notifications are discarded, and notification failures never rewrite a completed draft as failed.

Code changes do not hot-reload. Package a specific CI-approved commit as an immutable release according to [`deploy/README.md`](deploy/README.md), run `npm ci && npm run check` in an independent release directory, verify the SQLite/runtime-asset recovery unit, and only then switch and restart the single systemd instance. Never overwrite `/opt/zen-content-hub` from a dirty local worktree.

`RUN_RETENTION_DAYS` controls retention of terminal task records and their isolated run directories. `SLACK_THREAD_RETENTION_DAYS` controls thread context and event-deduplication records. Cleanup runs at startup. `cancelled` and `needs_input` use the same retention policy as other terminal states. Explicit cancellation removes the entire unfinished run directory; a task awaiting clarification keeps only `research-trace.json` and immediately removes other partial output. Back up the database and `/var/lib/zen-content-hub` before shortening retention.

Inspect live Exa calls and the latest company research trace:

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
npm run trace:research -- company
```

## Slack natural-language entry point

In a direct message, talk to the Bot like a normal AI assistant. Public channels require `@Bot` to avoid ingesting ordinary conversation. Under `NODE_ENV=production`, callers must be restricted with `SLACK_ALLOWED_USER_IDS` and `SLACK_ALLOWED_CHANNEL_IDS`, and rate-limited with `SLACK_RATE_LIMIT_PER_MINUTE`. New messages and final edits wait through a five-second quiet period by default; configure it with `SLACK_EDIT_DEBOUNCE_MS`.

Tasks are persistently deduplicated by `channel + message_ts + revision`. Editing the original message or adding prompt details in its thread cancels, cleans, and replaces an unpublished earlier revision. The enqueue acknowledgement includes the complete request, exact model/entity version, link count, and revision number.

Chinese and English instructions use the same router. The untruncated original Slack prompt is the highest authority for WeChat analysis requirements; workflow defaults cannot override its subject, comparison set, viewpoint, structure, length, or prohibitions. English is only the instruction language: WeChat and translation output remains Simplified Chinese by default, while Newsletter keeps its own language rules. A model-capability comparison remains general prompt-driven analysis even if it says `deep dive`; it does not trigger company financials, SEC, or value-chain research. A link is top-priority user material, not automatic translation intent. Only an explicit translation request enters the full translation workflow. Bare links and untyped tasks default to WeChat analysis.

QDII equity holdings accept `QDII:`, `Fund:`, `Holdings:`, `基金查询：`, or natural language containing a six-digit fund code plus QDII/fund/holdings/`持仓`. Without an explicit channel, the result is an English reply in the original Slack thread. `微信：` creates a Chinese WeChat draft by default, while `Newsletter:`, `Email:`, or `邮件：` creates an English Customer.io draft. An explicit language instruction overrides the default. The workflow produces both reply and draft only when both are explicitly requested. Ordinary Newsletter tasks remain draft-only.

User URLs and Slack attachments are read in full before cross-checking against the latest official/primary and configured preferred sources. Expanded search is disabled only when the original prompt explicitly says to use only that link; the planner cannot invent an exclusive-source constraint. Slack-escaped URLs are restored during enqueue and extraction. If Exa returns a crawl error or empty result for one user page, the service performs one targeted recovery search using domain, path, campaign semantics, and task requirements, then records each URL state and recovery result in `research-trace.json`.

PDFs, Notion, Google Docs, and GitHub repositories/files enter as first-class user sources but are not automatically treated as official facts. Private Slack files use the Bot token. Analytical PDFs use Datalab for structured parsing when available or Poppler for searchable text otherwise; scanned files fail explicitly without OCR. A task becomes `needs_input` only when user material and a primary source each carry clear evidence that conflicts on a core premise in a way that time or measurement cannot explain. The Bot asks one precise question in the original thread and does not repeat the conflict after an answer. Missing material, unverified models, and audit issues do not cause clarification loops; the system uses risk, impact, source, and confidence to choose a local repair or retain the issue for review.

To stop work, send `@ZenBot 停止当前任务`, `停止进程`, `取消任务`, `stop the current task`, `cancel task`, or `abort this job` in the original task thread or channel. Queued work is removed immediately. Running work aborts network requests, becomes `cancelled`, and deletes its own `runs/<run-id>/` directory while ZenBot remains online. Once WeChat or Customer.io draft creation begins, the task is not force-killed because a remote draft may already exist without a locally persisted `media_id`; the Bot reports this state clearly. Ordinary workflows create drafts only. `opening-digest` follows its separate audience and send gates.

## Workflows

| ID | Slack prefixes | Purpose |
|---|---|---|
| `wechat` | `wechat:`, `微信：`, no prefix | General WeChat Official Account article |
| `macro` | `macro:`, `宏观：`, natural language | Cross-asset macro event note, mechanism deep dive, or weekly review; WeChat draft only, no cron |
| `earnings` | `earnings:`, `财报：` | Earnings preview/review; fixed framework fills gaps only when the prompt provides no structure |
| `sector` | `sector:`, `行业：` | Sector analysis; fixed framework is fallback only |
| `morning` | `morning:`, `晨报：` | 24–48-hour morning brief |
| `translate` | `translate:`, `直译：`, `翻译：` | Faithfully translate the first link's structured content within the requested scope |
| `company` | `company:`, `公司：`, `个股：`, `深度：` | Explicit company financial, competitive, or value-chain analysis; does not capture model/product comparisons |
| `email` | `email:`, `邮件：` | Generate a versioned newsletter and create a Customer.io review draft |
| `qdii` | `qdii:`, `fund:`, `holdings:`, `基金查询：`, natural language | Query mainland public-fund QDII equity holdings and reply in Slack; may supply WeChat/Newsletter evidence |

These internal workflows are hidden behind rule-first, model-fallback natural-language routing. `macro` is selected automatically only when both a macro/cross-asset subject and analytical intent are present. It covers policy, economic data, rates, FX, liquidity, equities, commodities, credit, risk appetite, volatility, and digital assets. Company, earnings, and sector requests retain priority, and a mixed request chooses one complete workflow for the final question.

WeChat Analysis V2 freezes the original prompt into a `TaskContract`, derives English names, legal names, tickers, or regulatory aliases for Chinese entities, and produces up to `ANALYSIS_SEARCH_MAX_QUERIES` targeted searches (eight by default). Every task deterministically includes at least one Chinese and one English query, preferably two of each. Chinese company tasks also add official and industry searches for the English legal name; company workflows run quarterly-financial, regulatory-disclosure, and value-chain searches in parallel.

Dynamic queries containing “latest”, “newly released”, or “current” default to the previous `ANALYSIS_RECENT_WINDOW_DAYS` days (60 by default). Static official product pages and historical material are not constrained by this window. Official domains only discover candidates: a source must also match publisher, page type, and target entity before entering primary evidence. Within the same evidence tier, prefer English sources and independent third-party reporting or research in any language. Government-funded, state-owned, and public-broadcast media are removed from search results, while primary regulator, exchange, and statistics-agency documents remain valid. A restricted-media URL supplied by the user remains context only and cannot act as cross-validation or a final citation. Extend the built-in lists with `EXA_EXCLUDED_MEDIA_DOMAINS` and `EXA_INDEPENDENT_MEDIA_DOMAINS`. Unsupported `x.com`/`twitter.com` domains are removed before Exa requests to prevent a 4xx failure of an entire search lane. Results are ranked and quota-limited by user source, primary source, professional preferred source, open source, language/independence, and publication date before becoming the request-by-request `EvidenceMatrix`.

After the EvidenceMatrix, `wechat`, `sector`, `company`, and `earnings` use only the versioned `latepost-ai-writer` skill. `macro` loads both `global-macro-strategy-writer` and `latepost-ai-writer`: the macro skill owns fact/priced-expectation/incremental-information distinctions, cross-asset transmission, base and adverse scenarios, observation signals, and invalidation conditions. LatePost contributes evidence accounting, attribution, causal progression, fact auditing, and anti-fabrication discipline.

One direct primary or original source may support a core fact. Without primary evidence, the article must narrow itself to verified facts, open questions, and observation conditions. Key observation levels must be reviewable. The auditor prioritizes direct evidence for key numbers, market pricing, and market reaction in up to five selected end sources. High-risk inferences may remain without blocking a draft, but Slack requests human review. Do not write buy/sell, price-target, entry, exit, stop-loss, or position-sizing instructions. Only reliable data may enter Markdown tables with measurement, timestamp, and source.

No skill may override the original Slack prompt, source gates, user structure, workflow-specific method, or fixed output contract. Skill summaries, selected archetype, routing rationale, evidence boundary, final sources, and audit results are stored in `research-trace.json`. Skills do not apply to translation, morning briefs, or Newsletter, and may not make an article claim to represent a reference account or reproduce reference material.

Run the complete macro research, writing, audit, and pre-render path locally without Slack. `--dry-run` forces the mock channel and never calls the WeChat draft API:

```bash
npm run accept:macro -- --dry-run
```

Translation follows one fixed structured pipeline. It recognizes Chinese and English scopes such as `前 11 页`, `第 3–8 页`, `第 2.1 节`, `从 Introduction 到 Conclusion`, `first 11 pages`, `pages 3–8`, and `translate the Introduction section only`. It translates the full source only when no scope is present. English instructions do not change the target language; English sources still translate to Simplified Chinese by default.

arXiv prefers official HTML. Ordinary HTML preserves heading hierarchy, paragraphs, lists, quotations, original images and captions, tables, formulas, code, and references. Titled sandboxed `srcdoc` charts are lazy-loaded through the existing Chrome instance and captured in place as PNG; chart titles and explanations enter translation units, while external video remains as a source link. Notion prefers the official Markdown endpoint when `NOTION_API_TOKEN` is configured.

Datalab converts PDFs to structured HTML. Sibling pagination containers are concatenated in original `data-page-id` order and never passed through single-article Readability selection. A completed result must have a valid quality score, a continuous container set exactly matching the requested pages, and bidirectional agreement between returned images and HTML references. Poppler's text layer is then cross-checked against Datalab source text. Missing pages, collapsed body coverage, or detached figures hard-fail before translation and publication. Slack success messages and traces use actual page-level coverage and never report content without page records as “0 pages.”

alphaXiv links map by paper ID to the same official arXiv HTML/PDF while retaining the user URL for attribution. Bot detection relies on challenge-page structure/title or a short prompt page with no article body; paper text discussing CAPTCHA or `access denied` is not blocked.

Translation replaces only translatable text nodes: titles, body, lists, figure captions, and table captions. Original image files, formulas, code, citation numbers, URLs, and reference structure remain unchanged. Image support is determined by actual signatures rather than extensions or binary metadata text. SVG/WebP assets are rasterized to PNG and immediately signature-checked; a valid PNG containing SVG metadata is not rejected.

Original table cells are not translated or rebuilt as Markdown/HTML. The table is rasterized directly into a high-resolution PNG and inserted in original order, avoiding WeChat font, wrapping, and width distortions. Titles do not gain a translation suffix. The opening contains exactly one source-information block with original title, author, site, and URL, but no date or translation scope; repeated paper-title-page author and affiliation lists are removed before the abstract.

Body highlighting targets at least one phrase per roughly 200 Han characters and preferably two or three, prioritizing terminology, mechanisms, central claims, or key opening sentences; whole-paragraph bold is forbidden. Highlighting is degradable styling: malformed Markdown is safely removed without retranslation or blocking.

Numeric validation is semantic. Equivalent forms of `zero/one`, compound English numbers, ordinals, K/M/B/T, thousands separators, percentages, and Chinese ten-thousand/hundred-million units pass. Percentage morphemes are not misread as the number 100. LaTeX macros, URLs, formula/citation placeholders, tickers, and model names are immutable tokens. Untranslated-text detection masks these tokens first; formula-only or citation-placeholder-only blocks use token equivalence and do not mistake a marker such as `ZEN_INLINE` for untranslated prose.

Each block receives at most two targeted repair rounds. If an explicit number or immutable-token mismatch remains, the service selects the best complete translation, keeps the article clean, and records block ID, difference, source, candidates, and final choice in a Slack review notice and `research-trace.json`. Missing, duplicate, reordered, or visibly untranslated blocks still hard-fail, as do missing original images/table images/formulas or damaged assets. Each structurally valid text unit is checkpointed immediately, so another unit failing in the same batch does not discard completed work. Embedded text inside original images and table images is not OCRed, translated, or redrawn. Faithful translation takes priority over original-writing dash style; dollar signs before numbers no longer produce warnings, while all safety, integrity, fixed-template, and layout gates remain active.

HTML translation does not require Datalab. DigitalOcean Chrome captures dynamic embedded charts under the existing same-origin isolation without adding third-party parsers or cross-domain access. PDF translation requires `DATALAB_API_KEY`; orchestration, asset persistence, fixed-template rendering, and draft creation remain on DigitalOcean, while Datalab only performs temporary PDF parsing. The current 2 GB Droplet does not need Marker/MinerU installed.

Original analysis does not require Datalab when Poppler can extract a text layer. Scanned documents or tasks requiring chart/table/formula structure should configure Datalab. If a user document is blocked by its CDN, analysis tries exact search cache and URL-semantic recovery. For FCC PDFs it may derive a `DA` number from evidence and read the matching official TXT attachment from `docs.fcc.gov`, but only when institution, document number, and subject all match. If equivalence cannot be proved, the task stops instead of guessing a summary.

Notion pages use the official Markdown endpoint when `NOTION_API_TOKEN` is configured. Private pages must also be shared with the integration through `Add connections` in Notion. Public Google Docs can export HTML directly. Private documents should configure `GOOGLE_DOCS_CLIENT_ID`, `GOOGLE_DOCS_CLIENT_SECRET`, and `GOOGLE_DOCS_REFRESH_TOKEN`; the service refreshes short-lived access tokens automatically, while legacy `GOOGLE_DOCS_ACCESS_TOKEN` is a compatibility fallback. Analysis and translation share this read-only authentication path. If a user-provided Notion or Google Doc cannot be read, the task stops rather than ignoring the source and continuing search. Public GitHub repositories need no token; use a read-only `GITHUB_TOKEN` for private repositories or higher limits. See [`docs/private-documents.md`](docs/private-documents.md).

All article, PDF, document-API, and redirected URLs reject private network addresses on every hop and are bounded by source size, PDF page count, and redirect count. When configuring a new source, browser, Notion, Google Docs, or GitHub integration, first run a real-link acceptance check with `HUB_DRY_RUN=1`. See `.env.example` for configuration examples.

Generate a local translation acceptance draft without Slack. This calls OpenRouter but never the WeChat API:

```bash
npm run check:translation -- "翻译前 11 页 https://example.com/paper.pdf"
```

An operator may resume a failed translation using the original SQLite `runs.id`; do not use the hashed run-directory name:

```bash
npm run requeue:translation -- <run-id>
```

The command accepts only failed or interrupted `translate` tasks with a valid checkpoint. It rejects tasks with a `media_id`, other workflows, and failure types outside its allowlist. After requeueing, restart the single instance through the deployment environment's normal mechanism so startup recovery continues from the checkpoint.

V2 analyses historically blocked at `gate` by code-fence or four-space-code rules may use:

```bash
npm run requeue:analysis-gate -- <run-id>
```

This command accepts only historical `wechat`, `sector`, `company`, or `earnings` code-gate records, plus exact historical safe-rendering false positives for code line-break nodes. The task must have no `media_id` and must retain valid Slack notification metadata. All other states, gates, and published tasks are rejected. The command only changes the task to queued; it does not execute it directly.

Original analysis prefers official sources, but relevance and entity matching outrank domain. The writing model receives only EvidenceMatrix-selected material rather than dozens of mixed sources. Fact auditing for the five V2 analysis workflows (`wechat`, `sector`, `company`, `earnings`, and `macro`) classifies each issue by `impact` (core/supporting/incidental), `risk` (high/low), `origin` (user request, user material, evidence, inference, or model addition), and `confidence`.

Only high-confidence issues may be edited automatically. A model-added unsupported core or high-risk claim is locally qualified/replaced when direct evidence exists, otherwise removed. Removing a core sentence triggers one evidence-bound local rewrite attempt; if it still cannot stand, the workflow stops. Low-risk non-core issues, low/medium-confidence issues, explicit user premises, and labeled inferences remain in the article and are recorded for Slack/trace review. Premises from user URLs are attributed as project README/document statements; prompt-only premises are written as engineering assumptions, without mentioning Slack or “the user.” A second audit pass reviews only modified sentences and remaining high-risk facts and cannot cascade into a full rewrite. Legal V1, morning, and Newsletter do not use this tiered audit.

WeChat body copy contains no citation footnotes or inline source links. The system deterministically appends one left-aligned sources section with up to five actually used references from the EvidenceMatrix. URLs are deduplicated after removing common tracking parameters, URL-shaped source titles display the domain, and gates count only real Markdown link targets—not label text or image assets.

## Pre-publication processing

### Fixed-template contract

Every real draft created by the Bot must use a centrally registered fixed template. `src/lib/draft-template.js` is the only template registry. Ordinary WeChat and Customer.io use `zen-wechat/zen-trading@4` and `zen-customerio/zen-research@5`. Opening Digest uses `zen-wechat/zen-trading@5` and `zen-customerio/zen-research@6` for its earnings-preview layout. A real channel fails before any publishing API call if its template is unregistered, mismatched, or unlocked. Task text, workflows, and individual runs cannot choose another template. `mock` is dry-run only and is not a real draft channel.

With `OPENING_DIGEST_WECHAT_ENABLED=true`, `opening-digest` first sends or schedules the English Customer.io email, then uses the same frozen quote, earnings-preview, copy, and OIC payload to produce a complete Simplified Chinese translation and create a `Zen 开市日报 · YYYY-MM-DD` WeChat draft. The English editorial section contains 3–5 `Today's catalysts`, each no more than 40 visible English words. `Market read` is one 3–5-sentence paragraph of at most 80 words with an overview-detail-(optional summary) structure.

After severe fact review, overlong blocks receive one local compression and semantic review. A changed link, number, ticker, date, or time—or failed review—reverts that block to its source and records only trace diagnostics; it does not block sending. The WeChat draft fixes `zen-wechat/zen-trading@5`, a nine-cell quote grid, and an OIC 20×8 two-row record block. Off-site links keep visible text only. WeChat translation, creation, or readback failures never undo the email; the main task completes from the email result and sends a precise Slack warning.

Manual Slack `opening-digest` triggers are isolated test runs. The recipient subject is `[TEST] Zen Opening Digest · Month D, YYYY` without a run ID. The Customer.io internal name and cover asset keep a unique ID, and the WeChat title carries `[测试]`, so a test cannot discover, reuse, or overwrite the day's formal draft. Only weekday cron may create or reuse an unmarked formal Opening Digest.

Template redesigns must update the centralized implementation, increment registry versions, and synchronize channel tests, rendering goldens, and this README. Never bypass the template in one task. Titles, body, links, edition, and audience fill template slots without modifying the template itself.

`src/channels/wechat-draft.js` runs these steps in order:

1. Check title, suspected credentials, local paths, and format warnings. Code from a translation source or explicitly requested in the original prompt (including examples or ASCII diagrams) is deterministically authorized. The model cannot authorize code itself. Unauthorized code becomes a Slack review warning but does not block. Standalone four-space code becomes a `text` fence; existing fences, HTML `pre`, and nested lists remain unchanged.
2. Check mobile readability of Markdown tables in original articles. Keep compact five-column tables. Split an unreadable wide table into narrow tables by retaining the first column and grouping three metrics, then run the final gate. Translation tables are already original-source PNGs and do not enter this rewrite.
3. Inject `assets/zen-header-banner.gif` at the start of Markdown.
4. For writing tasks other than translation, ask OpenRouter to plan up to `INFOGRAPHIC_MAX_IMAGES` images (template, data, insertion anchor), render them locally to SVG through `@antv/infographic` SSR in `tools/infographic-generator`, capture PNG with Playwright, and insert after the anchored heading or paragraph. Image text and numbers must come from the article. Planning, rendering, or anchor failures warn and skip only that image. Retries remove deterministically named `infographic-N.png` assets before regeneration. Disable globally with `INFOGRAPHIC_ENABLED=false`.
5. Ask OpenRouter to extract cover fields, then render title and subtitle over the fixed white `assets/zen-cover-background.png` through `tools/cover-generator`, producing a 900×383 cover matching the source image. Set `COVER_GENERATOR_DIR` only for a replacement implementation. The browser uses `COVER_BROWSER_EXECUTABLE`, then the translation browser setting, then common Chromium/Chrome locations.
6. Render body copy with `@wenyan-md/core` and fixed `assets/zen-trading.css`; code uses light highlighting with `macStyle:false` without changing the template ID. Final HTML normalizes citation and source-information blocks to body font size, then blocks oversized non-heading text, duplicate source-information blocks, dangerous embedded nodes, and empty or structurally invalid code. Credential, local-path, and live-process-secret gates still apply to Markdown code.
7. Append `assets/zen-survey-qr.jpg` and `assets/zen-footer-qr.png` in that order to final HTML. The survey must be the penultimate node and the community footer the final node, adjacent with nothing after them, before upload to WeChat. Override with `WECHAT_SURVEY_IMAGE` and `WECHAT_FOOTER_IMAGE`; both footer images must exist together.

Cover-field extraction falls back to template example data. Cover-file generation failure blocks publication.

## Testing

```bash
npm run check
```

`npm run check` validates syntax, runs the complete test suite, and audits production dependencies at high severity. Tests use stubs or in-memory data and require no live business credentials. Golden tests lock rendering output. Update them only after confirming an intentional rendering change:

```bash
npm run test:update-golden
```

## Extending the service

- New article type: add `src/workflows/<name>.js` and register it in `src/index.js`.
- New publishing channel: add `src/channels/<name>.js` with `publish()`, register it in `src/index.js`, and first register its fixed template in `src/lib/draft-template.js`. An unregistered real channel fails closed.
- New scheduled task: add `cron:<expression>` to the workflow's `triggers`. Startup validates the expression and timezone. A fixed schedule that must catch up after restart also needs a stable business-date key and bounded catch-up window; a database uniqueness constraint prevents duplicate enqueueing.

Preserve the contract that `runWriter()` creates `article.md` inside each task's isolated directory and that a successful publication persists `media_id` immediately for idempotency. Notifications are ancillary results: even through the durable outbox, a Slack delivery failure must not override a successfully created draft.

### Customer.io Newsletter

The Newsletter workflow uses the Customer.io App API and fixed `zen-customerio/zen-research@5` template to create a Newsletter Broadcast draft named `Zen Research from Zen Trading · Vol. N`. It never sets `send_now` or `scheduled_at`. Rendered HTML must carry that template identifier or the Customer.io call is blocked.

The desktop layout uses compact spacing. At widths up to 640px, shell horizontal padding becomes 4px and body/footer padding becomes 8px so data tables approach the card edges. The footer always displays `700 Leahy St, Redwood City, CA 94061` and company LinkedIn `https://www.linkedin.com/company/110921483`; neither environment variables nor a task may override them.

Audience expansion is staged through `NEWSLETTER_AUDIENCE_STAGE=internal|pilot|full`: internal is `Newsletter · Internal Beta` (ID `17`), pilot is `Newsletter · Pilot` (ID `18`), and the full candidate group is `Valid Email Address` (ID `6`). The Bot reads each segment's live count and applies stage limits before creating a draft. `full` additionally requires `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`.

All subsequent Customer.io Newsletters use the visible sender `Zen Trading <support@zentradings.com>`. Both the channel and read-only checker reject any other From address to prevent configuration drift.

Every email ends with satisfied/not-satisfied links. With `CUSTOMERIO_NEWSLETTER_FEEDBACK_URL`, they append `rating` and `edition`; otherwise they fall back to a prefilled contact `mailto:`. Customer.io MCP is not part of the core publishing path, avoiding additional send permissions for automated tasks.

Newsletter first classifies content. Market, sector, company, earnings, and data analysis are research content: they retain primary-source search and fact review but impose no minimum number of official links in body copy. Welcome emails, needs collection, Agent/product introductions, notices, invitations, and feature updates are relationship/notification content: they use only user material, perform no irrelevant market search, and require no official citation. An explicit request for official data or market analysis takes precedence and uses the research path.

Run `npm run check:customerio` for a read-only check of live counts across all three stages, current drafts, and missing configuration.

See [`docs/NEWSLETTER_ROLLOUT.md`](docs/NEWSLETTER_ROLLOUT.md) for the complete staged testing, review, and expansion procedure.
