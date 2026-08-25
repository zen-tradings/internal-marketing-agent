# Zen Content Hub Guide: Life of a Task + Where to Change What

> A maintainer's map of the project. For architecture and deployment see README.md; this document answers only two questions: **how things flow**, and **which file to touch to change a given behavior**.

## 1. Life of a Task (Main Pipeline)

You send `@bot earnings: Micron FY26Q3 https://example.com/xxx` in Slack. Then, in order:

```
① Trigger    src/triggers/slack.js
   Socket Mode receives the message → parseSlackTask extracts the task text
   (cleans Slack link formatting) → resolveWorkflowTask recognizes the
   "earnings:" prefix → workflowId = earnings → user/channel allowlists and
   per-minute rate limiting → debounce of new messages/edits → persistent
   dedup on channel + message_ts + revision → enqueue to the database
   (SQLite runs table, status queued)

② Queue      src/core/queue.js + src/core/store.js
   Bounded priority queue with at most two concurrent dequeues; status
   queued → running. Opening Digest only prioritizes pending tasks, never
   preempts. Each active task owns an AbortController and a
   generate/publish phase marker; Slack stop commands (Chinese or English)
   can cancel a task during the generate phase and clean up its run
   directory; force-kill is refused once the task enters an external
   publish phase. On crash/restart, running tasks are marked interrupted;
   persisted queued tasks resume on next start. Historical interrupted
   tasks require an explicit admin requeue, so they are never auto-published
   by mistake.

③ Research + writing   src/core/analysis-v2.js + src/core/runner.js
   WeChat original/sector/company/earnings/macro first freeze the
   untruncated raw Slack Prompt into a TaskContract, extract
   English/legal aliases, then generate up to 8 targeted SearchPlan
   queries. Slack PDF/text attachments and PDF/Notion/Google Docs/Linear/GitHub
   URLs are read in parallel with Exa search and kept as first-class user
   sources. Private Notion, Google Docs, and Linear issue reads hard-fail
   the task. For other user URLs, recovery tries the exact cache and then
   URL-semantic recovery; an FCC PDF is restored via the official
   docs.fcc.gov TXT attachment only when agency, `DA` document number,
   and file subject all match, proving it is the same user document.
   Every task includes at least one Chinese and one English query, and
   by default cross-verifies with the latest official/primary sources,
   established priority sources, and open sources. Within the same
   evidence tier, prefer English sources or independent third-party
   institutions in any language; search results deterministically exclude
   government-funded, state-owned, and public-broadcast media. Raw
   filings from regulators, exchanges, and statistics bureaus still count
   as primary evidence; restricted media proactively supplied by the user
   is context only, never corroboration or citation. Company tasks also
   run three extra deep-search tracks: quarterly financials, regulatory
   disclosures, and value chain. Retrieval results are organized into an
   EvidenceMatrix keyed by each user requirement; static domains are for
   discovery only — a source is primary only when publisher, page type,
   and target entity all match. Once the matrix is complete, generic
   tasks are routed to latepost-ai-writer, which selects a controlled
   article type, an evidence-supported angle, the core tension, and
   ending constraints; the Slack Prompt, source safety, user-specified
   structure, and workflow methodology always take precedence. The body
   model receives only relevant evidence; production generic body text is
   written by Qwen3.8-Max, while the Opening Digest English main draft
   independently uses GPT-OSS 120B. GLM 5.2's fact audit returns exact
   offending sentences with local actions classified by impact, risk,
   source, and confidence; low-risk / medium-low-confidence / user-stated
   premises are kept for review, and only high-confidence issues may be
   auto-fixed — never a full rewrite. Missing material and unsupported
   sentences no longer trigger questions; only a bilateral, irreconcilable
   conflict between user material and primary sources over a core premise
   routes to needs_input, and answering in the same thread is never
   re-asked. Citation links are deterministically selected from the
   evidence matrix and appended by the system, never maintained by the
   model. Macro prefers evidence directly tied to key requirements such
   as probability, price, yield, and market reaction; the audit then
   returns at most four key claim/evidence-ID groups, merged with at
   least one core primary source into at most five final curated sources.
   Macro also loads global-macro-strategy-writer, which leads on priced-in
   expectations, incremental information, cross-asset transmission,
   two-sided scenarios, watch signals, and invalidation conditions; the
   LatePost method only supplements evidence, attribution, causal
   progression, and fabrication avoidance. Its trace additionally records
   the dual skills, chosen article type, Slack routing reason, evidence
   boundaries, final curated sources, and macro audit results.
   Medium/low-confidence high-risk inferences may be kept and the draft
   created, but a human-review reminder must be posted to the original
   Slack thread. Production runs V2 by default; the V1 path is kept only
   as a single-instance emergency fallback via ANALYSIS_PIPELINE_VERSION,
   uses a deterministic article-type fallback, and is not a daily mode.
   The writing skill applies only to WeChat original, sector, company,
   earnings, and macro; translation, morning digest, and Newsletter do
   not load it. Macro has only a Slack trigger, no cron, and its channel
   is fixed to WeChat draft — it never auto-publishes.
   Calls OpenRouter chat completions (generic body model = `OPENROUTER_MODEL`
   in `.env`; Opening Digest English main draft = `OPENING_DIGEST_MODEL`,
   falling back to the generic model when unset). Each task uses its own
   `workDir/runs/<readable-run-id>-<hash>/` computed by `runWorkDir()`,
   producing article.md inside it (title frontmatter is a hard contract;
   checkpoints and generated assets must never be reused across tasks).

④ Publish    src/index.js → src/channels/wechat-draft.js  (publish)
   draft-template.js first verifies the real channel has a registered and
   locked fixed template; unregistered or mismatched channels are refused
   → four-space code is normalized to text fences; gate.js (errors block:
   missing title / secrets / local paths; unauthorized code is only a
   warning) → at the Markdown stage assets.js injects the fixed header
   image assets/zen-header-banner.gif → cover generation cover.js (a cheap
   model extracts cover data → the in-repo cover-generator renders with
   headless Chromium; field-extraction failure falls back to safe
   defaults, generator failure or timeout blocks publishing)
   → @wenyan-md/core rendering; wechat-render.js appends
   assets/zen-survey-qr.jpg then assets/zen-footer-qr.png at the end of
   the final HTML, then uploads to the WeChat draft box (RENDER_OPTS is a
   hard character-level parity constraint with wenyan-mcp — never change
   it) → persist the returned media_id (idempotency anchor)

⑤ Report     src/core/notifier.js
   The enqueue receipt shows the full Prompt, exact models, link count,
   and revision number. Success/failure/warning/clarification all reply
   in the original Slack thread. Terminal-state notifications and QDII
   core replies go into the SQLite outbox on failure and are re-sent
   against the task's current state once Slack recovers; progress and
   warnings remain best-effort. A notification failure must never flip an
   already-created draft to failed.
```

## 2. The Three Layers of Configuration

1. **`.env` (runtime switches; restart the process after changes)**: secrets, models, task directories, queue limits, fetch/external-API timeouts, Slack allowlists, data retention, `HUB_DRY_RUN=1`, fixed header image, the two fixed footer images, and cron expressions. See `.env.example` for the full list and deployment-oriented example values; `src/config/index.js` owns fallback defaults when a key is absent. The service does not configure or validate a public egress IP.
2. **`src/workflows/*.js` (declarative workflows)**: each file declares an id, triggers, channels, priority sources, and a fallback methodology. In V2 the Slack Prompt drives content; sector/company/earnings methodologies only fill in structure the user did not specify. Shared sources live in `workflows/shared.js`; structured translation keeps its own fixed pipeline.
3. **`src/config/index.js` (translation layer from env → config object)**: give new env keys their defaults here.

## 3. To Change Something, Go Here

| Behavior to change | File | Notes |
|---|---|---|
| Analysis Prompt contract, evidence matrix, local audit | `src/core/analysis-v2.js` | Raw Prompt has top priority; pure functions for easy regression |
| WeChat analysis orchestration and external calls | Analysis V2 branch of `src/core/runner.js` | Planning, Exa, writing, audit, deterministic citations |
| Chinese original-writing method, article types, quality checks | `skills/latepost-ai-writer/` + `src/lib/editorial-skill.js` | Routed after the EvidenceMatrix; trace records summary, type, and angle; must not override user structure |
| All-asset macro method, three article types, sample index | `skills/global-macro-strategy-writer/` + `src/workflows/macro.js` | Macro leads, LatePost constrains evidence; WeChat draft only, no cron |
| User attachments and direct documents | `src/core/user-sources.js` | Slack private files, PDF, Notion, Google Docs, Linear issues, GitHub; read in parallel and keep first-class source identity; official mirrors of blocked documents must verify agency, document number, and subject |
| QDII fund holdings data | `src/core/qdii.js` + `python/qdii_worker.py` | AKShare used when fresh; stale/empty data falls back in order to CSRC, exchanges, and verifiable fund companies; PDF downloads still go through the safe-network gate |
| Fallback article structure | `defaultMethodology` in `src/workflows/<id>.js` | Only fills gaps the user did not specify |
| Adding a new article type | New `src/workflows/<name>.js` + WORKFLOWS registration in `src/index.js` | Copy the structure of earnings.js |
| Company deep-dive fallback framework | `src/workflows/company.js` | Only when the Prompt genuinely asks for company financials/competition/value chain |
| Slack Chinese/English triggers, edits, supplements, stop, routing | `src/triggers/slack.js` | Macro requires a macro theme + analysis intent; company/earnings/sector take priority; a mixed request picks exactly one workflow |
| Translation scope detection | `src/workflows/translation-scope.js` | Page and section ranges; user page numbers are 1-based, converted to 0-based for Datalab requests |
| Translation content extraction/structure | `src/workflows/translation-source-text.js` | arXiv HTML preferred, alphaXiv maps paper IDs to official arXiv; anti-bot pages recognized by structure and short probes; plain HTML/Notion/Linear keeps headings, paragraphs, figures, formulas, code, and citations |
| Structured PDF parsing | `src/workflows/datalab-parser.js` | Translation/scans go through managed Datalab; a completed parse must stably return a valid quality score, complete contiguous pagination, and bidirectionally matched image references; analytical PDFs with a text layer may fall back to Poppler in `user-sources.js` |
| Translation fidelity/completeness/checkpoint | `src/workflows/translation-source-text.js` | Datalab multi-page root containers parsed in original order; three-way coverage validation across Poppler/Datalab/structured body; per-text-node translation; immutable tokens masked before untranslated-text detection; pure formula/citation placeholder blocks get token-equivalence checks only; at most two targeted repair rounds, lenient-review exception, per-unit checkpoints, and hard structure/asset gates |
| Translation execution and research trace | `src/workflows/translate-engine.js` | Writes the manifest, strict-equivalence status, blocks pending review, all candidates, and the final selection to the trace |
| Restricted resume of failed translations | `scripts/requeue-translation.mjs` + `src/core/store.js` | Accepts only a database run-id; requires a checkpoint; rejects other workflows, tasks with a `media_id`, and non-allowlisted failures |
| Restricted requeue of analyses blocked by legacy code gates | `scripts/requeue-analysis-gate.mjs` + `src/core/store.js` | Only legacy gate/safe-render compatibility errors in the four V2 analysis flows; rejects published tasks, tasks without Slack notification, and other errors |
| Document-fetch configuration | `TRANSLATION_*` / `NOTION_API_TOKEN` / `LINEAR_API_KEY` / `GOOGLE_DOCS_CLIENT_ID` / `GOOGLE_DOCS_CLIENT_SECRET` / `GOOGLE_DOCS_REFRESH_TOKEN` / `GITHUB_TOKEN` / `DATALAB_*` in `.env` | Controls sources, private documents, PDF page counts, browser, parse quality, timeouts, and redirects; access tokens are a compatibility fallback only |
| Per-task cancellation, publish-phase protection, garbage-directory cleanup | `src/core/queue.js`, `src/index.js`, `src/lib/task-cancellation.js` | generate is cancellable; force-kill refused after publish; cancelled tasks end in status cancelled |
| Adding/removing priority-source domains | List in `workflows/shared.js`, or `.env` EXA_PRIORITY_DOMAINS | Write the apex domain; subdomains match automatically |
| Gate rules (block/warn) | `src/lib/gate.js` + `src/lib/code-blocks.js` | Unauthorized code only warns; secrets/local paths still hard-block; investment-advice sensitive words were removed — do not add them back |
| WeChat wide-table readability and auto-splitting | `src/lib/mobile-tables.js` | Compact five-column tables may pass; unreadable tables are split first, and the gate blocks only when conversion fails |
| Replacing fixed header/footer images | Replace files under `assets/`, or override with `WECHAT_HEADER_IMAGE` / `WECHAT_SURVEY_IMAGE` / `WECHAT_FOOTER_IMAGE` | Markdown injects only the header; the final HTML forces the last two images to remain, in order, the survey image and the community back cover |
| Cover layout/fields | `tools/cover-generator/template.html` | Override `COVER_GENERATOR_DIR` for a custom generator; the data-extraction prompt lives in `src/lib/cover.js` |
| Analysis models and budgets | `OPENROUTER_MODEL` / `OPENROUTER_ROUTER_MODEL` / `OPENROUTER_PLANNER_MODEL` / `OPENROUTER_REVIEW_MODEL` / `ANALYSIS_*` in `.env` | Body, routing, planning, and audit are separated; production defaults to V2 |
| Fixed-template master gate for drafts | `src/lib/draft-template.js` | Every real channel must register and lock a template ID; tasks must not override it; a redesign must bump the version and update tests |
| WeChat render theme | `zen-wechat/zen-trading@6`, `assets/zen-trading.css`, `assets/zen-section-heading-card.png`, and `RENDER_OPTS` | Theme files deploy with the repo; body `h2` headings are rasterized onto a clean card plate, and Chromium fits long bilingual copy within fixed safety margins before capture; blockquotes normalize to body size; the final HTML runs font, duplicate-source, and fixed-footer-order checks before publishing |
| Customer.io email drafts | `src/workflows/email.js` + `src/channels/customerio-draft.js` | Fixed `zen-customerio/zen-research@5`; mobile shell 4px side padding, body 8px; footer address fixed at `700 Leahy St, Redwood City, CA 94061`, LinkedIn fixed at `https://www.linkedin.com/company/110921483`; creates drafts only; audience controlled by the internal/pilot/full three-stage configuration |
| Opening Digest daily brief | `src/workflows/opening-digest.js` + Customer.io/WeChat/Discord channels | Generated 10:15 ET, target 10:30; English main draft uses `OPENING_DIGEST_MODEL` (GPT-OSS 120B in production); Kimi planning, GLM review/compression, and Qwen Chinese translation follow the global role configuration. Fixed 72 tickers for prices/OIC/company news; yfinance/Yahoo extract earnings candidates from now through Friday across major US stocks and important ADRs, excluding OTC, showing at most 6 names balanced across broad market and AI/tech; exact call times come only from official issuer announcements. Dedicated Customer.io/WeChat templates are `zen-customerio/zen-research@7` / `zen-wechat/zen-trading@7`; both bodies end with a fixed Discord community link (plain text on WeChat, above the survey/QR tail images, since off-site hrefs are forbidden there); WeChat earnings previews list one ticker per line. The email sends/schedules first; WeChat and Discord both reuse the same frozen payload. Discord enqueues to the persistent outbox only on the official cron, publishing the full English body, nine-grid quotes, and available OIC; manual TEST runs never reach `#newsletter-feed`. Failures in either derived channel never rewrite the email result; quotes, earnings calendar, OIC, cover, or search failures follow the established soft degradation and are recorded in the trace |
| New publishing channel | New `src/channels/<name>.js` implementing publish() + template and channel registration | See the README "Extending" section; unregistered templates fail closed |
| Offline eval harness (Metrics A/B) | `src/eval/` (`harness.js`, `cases.js`, `checks/`, `meta.js`, `mutations.js`) + `scripts/eval-run.mjs` / `eval-harvest.mjs` | Checkers replay production gate code (routing, source policy, citations, contract gates, Opening Digest limits, options math, QDII reconcile) over labeled fixtures in `test/fixtures/eval-cases.jsonl`; `--mutate` injects known defect classes to measure checker recall; `--verdicts`/`--meta` accumulate FN/FP rates with Cohen's kappa; fixture labels and independent harvested labels are kept separate |
| Value metrics (Metric C) | `src/eval/value.js` + `scripts/eval-value.mjs` | Strategy expectancy vs. baseline, reader satisfied-rate, editor edit distance; data collection happens outside the repo, this module only computes the statistics |

## 4. Daily Operations

### macOS local launchd

```bash
# Status / logs
launchctl print gui/$(id -u)/com.zentrading.content-hub | head
tail -f ~/Library/Logs/zen-content-hub/out.log

# Make code changes take effect (launchd does not auto-reload)
launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub

# Development: stop the daemon first, then run manually, to avoid two
# instances consuming the same Slack messages
scripts/uninstall-launchd.sh && HUB_DRY_RUN=1 node src/index.js
# Reinstall when done
scripts/install-launchd.sh
```

### Linux / DigitalOcean systemd

For directory layout, first-time install, immutable release packages, SQLite and runtime-asset recovery-unit backups, security updates, and health checks, see [`../deploy/README.md`](../deploy/README.md). For QDII development, first run `npm run setup:qdii` to build the Python 3.11+ virtual environment. Updates happen only through `npm run deploy:digitalocean`: install locked Node/Python dependencies and run checks in a separate release directory, then verify the SQLite and runtime-asset recovery-unit backups, switch over, and restart the single systemd instance. The live directory is marked with `.deploy-commit` and does not depend on an online `git pull`.

Acceptance order after changing any `src/` code: `npm run check` (tests use no real business credentials; the dependency audit reaches the npm registry) → run real connectivity checks as needed → verify the SQLite and runtime-asset recovery-unit backups → explicitly restart the corresponding service. Never pull from Git and restart without checks.

For translations that failed structured validation, do not hand-edit the database. After confirming the target version is deployed, recover with the database run-id following the restricted-resume steps in [`../deploy/README.md`](../deploy/README.md); once the command validates the checkpoint and `media_id`, restart the single instance and let the persisted queue take over. For the four V2 analysis flows blocked by legacy code-fence/four-space gates, recovery is only via `npm run requeue:analysis-gate -- <run-id>`; that command also only enqueues and never runs directly.

## 5. Suggested Reading Order (First Time Through the Code)

1. `src/index.js` — the assembly entry point; see how ①–⑤, connection recovery, health checks, and graceful shutdown wire together in `makeHandler` and `main`.
2. `src/workflows/wechat.js` + `shared.js` — what declarative configuration looks like.
3. `src/core/runner.js` — research + writing; the bulk of the business logic.
4. `src/channels/wechat-draft.js` — the deterministic step order of the publish path.
5. Everything else (store/queue/notifier/triggers) is thin — read it when you run into it.

Every module uses dependency injection (`makeXxx({ deps })`) with a same-named test file under `test/`; to confirm a behavior, reading the test cases is often faster than reading the implementation.
