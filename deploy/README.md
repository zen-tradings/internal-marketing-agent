# Linux / DigitalOcean deployment

The service is designed to run as one systemd instance. Do not start a second
manual process with the same Slack tokens or SQLite database.

## Production target and release command

The production target is never inferred from local SSH aliases or historical
VPS names. Copy the tracked template, set the real Droplet SSH target, and keep
the resulting file local:

```bash
cp deploy/target.example.env deploy/target.env
$EDITOR deploy/target.env
```

Run the read-only preflight first. It refuses non-DigitalOcean hosts by checking
the Droplet metadata service, then verifies the active service, `.deploy-commit`,
Slack readiness, idle queue and current model roles:

```bash
npm run deploy:digitalocean
```

After reviewing the preflight output, activate the exact pushed commit:

```bash
npm run deploy:digitalocean -- --commit "$(git rev-parse HEAD)" --max-concurrency 2 --opening-digest-model openai/gpt-oss-120b --opening-digest-wechat-enabled true --sync-discord-config --activate
```

需要同时切换 Opening Digest 的受控测试受众时，必须通过同一事务化部署命令传入已在 Customer.io 核验的 segment ID；部署失败会连同受保护环境文件一起回滚：

```bash
npm run deploy:digitalocean -- --commit "$(git rev-parse HEAD)" --max-concurrency 2 --activate --opening-digest-segment-id 19
```

The command requires a clean worktree and a commit present on the upstream
branch. It creates a local archive, stages and tests a separate release on the
Droplet, runs the SQLite backup service, requires an idle queue, reasserts the
approved model and QDII runtime values and rejects drift with a checksum that
excludes exactly the environment values managed by this deployment command. It preserves
`OPENING_DIGEST_MODEL`, `OPENING_DIGEST_WECHAT_ENABLED`, and the current
`MAX_CONCURRENCY` unless an explicit deploy argument overrides them (and only changes the protected Opening
Digest segment ID when it is supplied). The versioned backup helper is installed
transactionally before the backup and restored with the prior application on failure;
the deployment verifies the database-and-artifact manifest before switching. It then
switches the single systemd service and verifies the marker, main PID and `/ready`.
A failed activation restores
the previous release and protected environment file. The DigitalOcean metadata
check is a deployment-target guard only; it is not an application startup,
publishing or public-IP gate.

## Filesystem layout

```text
/opt/zen-content-hub/          active immutable release (`.deploy-commit`)
/opt/zen-content-hub.release-<sha>/  staged release before activation
/opt/zen-content-hub.rollback-<sha>/ previous release kept for rollback
/etc/zen-content-hub/          secrets and runtime configuration directory
/etc/zen-content-hub/zen-content-hub.env  service environment (0640, root:zenbot)
/var/lib/zen-content-hub/      SQLite database and per-run artifacts
```

Install Node.js 22+, Python 3.11+ with `venv`, Chrome/Chromium, and Poppler.
The cover generator and its OFL-licensed Resource Han Rounded CN Medium display font are versioned
in `tools/cover-generator`, so cover rendering does not depend on host-installed CJK fonts.
Run `npm ci` in `/opt/zen-content-hub` and set these
Linux-specific values (use the actual browser executable installed on the
host):

```dotenv
WORK_DIR=/var/lib/zen-content-hub/work
DB_PATH=/var/lib/zen-content-hub/runs.db
TRANSLATION_BROWSER_EXECUTABLE=/usr/bin/google-chrome
# Opening Digest reuses the same Chrome binary. OIC storage state must live
# outside immutable releases and be readable by zenbot (root:zenbot, 0640).
OPENING_DIGEST_BROWSER_EXECUTABLE=/usr/bin/google-chrome
OIC_STORAGE_STATE_PATH=/etc/zen-content-hub/oic-storage-state.json
DATALAB_API_KEY=replace-with-datalab-api-key
DATALAB_MODE=balanced
CRON_TIMEZONE=America/Los_Angeles
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8080
# The validated 1 vCPU/2GB host uses two task slots while remaining one process.
MAX_CONCURRENCY=2
MAX_QUEUE_SIZE=100
BROWSER_CONCURRENCY=1
WECHAT_WRITE_CONCURRENCY=1
CUSTOMERIO_WRITE_CONCURRENCY=1
OPENROUTER_CONCURRENCY=2
# Structured translation uses the same model by default with an independently configurable role;
# live no-regression acceptance requires high reasoning. One long translation may consume both global slots.
OPENROUTER_TRANSLATION_MODEL=qwen/qwen3.8-max
OPENROUTER_TRANSLATION_REASONING_EFFORT=high
TRANSLATION_BATCH_CONCURRENCY=2
EXA_SEARCH_QPS=8
QDII_ENABLED=true
QDII_PYTHON_PATH=.venv/bin/python
QDII_WORKER_PATH=/opt/zen-content-hub/python/qdii_worker.py
OPENROUTER_MODEL=qwen/qwen3.8-max
OPENROUTER_ROUTER_MODEL=z-ai/glm-5.2
OPENROUTER_PLANNER_MODEL=moonshotai/kimi-k3
OPENROUTER_REVIEW_MODEL=z-ai/glm-5.2
OPENROUTER_REASONING_EFFORT=high
OPENROUTER_PLANNER_REASONING_EFFORT=high
OPENROUTER_REVIEW_REASONING_EFFORT=none
OPENROUTER_ROUTER_REASONING_EFFORT=none
OPTIONS_STRATEGY_MODEL=anthropic/claude-fable-5
OPTIONS_STRATEGY_REASONING_EFFORT=high
OPTIONS_STRATEGY_MAX_TOKENS=32000
OPTIONS_STRATEGY_TIMEOUT_MS=900000
OPENING_DIGEST_MODEL=openai/gpt-oss-120b
# Full English multi-post delivery for formal cron runs only. Keep the webhook
# secret in this root-owned environment file; never commit it.
DISCORD_OPENING_DIGEST_ENABLED=false
DISCORD_OPENING_DIGEST_WEBHOOK_URL=
# Optional target lock. Set this to the #newsletter-feed channel snowflake
# after the read-only check below reports it.
DISCORD_OPENING_DIGEST_CHANNEL_ID=
DISCORD_WEBHOOK_TIMEOUT_MS=30000
DISCORD_WEBHOOK_MAX_ATTEMPTS=8
ANALYSIS_PIPELINE_VERSION=v2
ANALYSIS_SEARCH_MAX_QUERIES=8
ANALYSIS_RECENT_WINDOW_DAYS=60
# Optional comma-separated extensions to the built-in editorial source policy.
EXA_EXCLUDED_MEDIA_DOMAINS=
EXA_INDEPENDENT_MEDIA_DOMAINS=
NOTION_API_TOKEN=replace-if-private-notion-pages-are-used
LINEAR_API_KEY=replace-if-private-linear-issues-are-used
GOOGLE_DOCS_CLIENT_ID=replace-if-private-google-docs-are-used
GOOGLE_DOCS_CLIENT_SECRET=replace-if-private-google-docs-are-used
GOOGLE_DOCS_REFRESH_TOKEN=replace-if-private-google-docs-are-used
# Legacy short-lived fallback only:
GOOGLE_DOCS_ACCESS_TOKEN=
GITHUB_TOKEN=replace-if-private-github-repositories-are-used
SLACK_EDIT_DEBOUNCE_MS=5000
SLACK_POST_INTERVAL_MS=1000
SLACK_ALLOWED_USER_IDS=U0123456789
SLACK_ALLOWED_CHANNEL_IDS=C0123456789
```

The immutable deploy command creates a release-local `.venv`, installs
`python/requirements-qdii.lock`, and runs both restricted worker self-tests before
the normal Node checks. The host must provide `python3`, `python3-venv`, Poppler,
and the native libraries required by OpenCV/Camelot. The QDII worker only accepts
validated six-digit fund codes or local PDFs already downloaded through the Node
safety gate. The Opening Digest worker accepts only a bounded date range and limit,
then calls the fixed yfinance earnings-calendar API; neither worker accepts an
arbitrary URL. Run `npm run check:earnings-calendar` manually when a live Yahoo
connectivity/schema check is required; it is intentionally excluded from offline
`npm run check`.

The Slack app's Bot Token Scopes must include `files:read` before it can
download private PDF or text attachments from `files.slack.com`. After adding
the scope, reinstall the app to the workspace and rotate `SLACK_BOT_TOKEN` in
the protected environment if Slack issues a new token.

Structured HTML and arXiv HTML translation run directly in this Node.js
service. PDF translation sends the downloaded PDF to Datalab's hosted
conversion API, then immediately stores the returned images inside that run's
artifact directory before translation and rendering continue locally. The
Droplet therefore does not need Marker/MinerU models; `DATALAB_API_KEY` is
required only when a translation resolves to PDF. Keep it in the protected
service environment, never in the repository.

Translation inference is remote and I/O-bound. A single long translation runs at most two independent batches while the global OpenRouter gate remains fixed at two across the process. Keep translation reasoning at `high`: live A/B acceptance on the same paper found that `low` and `medium` reduced latency but introduced truncated blocks, while `high` retained strict equivalence. Short fragmented sources adapt from 24 to 48 items per batch without exceeding 8,000 source characters. Low-confidence numeric-format warnings go directly to review instead of consuming two repair calls; explicit numeric/token differences retain the two-round repair limit. `research-trace.json` stores content-free batch timing, resource wait, generation ID, model/provider, finish reason, token usage and cost for each OpenRouter attempt. The production startup gate rejects `TRANSLATION_BATCH_CONCURRENCY` above 2.

The no-publish live acceptance baseline for this design used two recent arXiv documents, Linear ZEN-38, and the 120k-character production webpage. With `high` reasoning, arXiv 2508.00828 fell from 32.1 to 20.9 minutes with strict equivalence; arXiv 2603.04601 fell from 37.7 to 34.8 minutes with the same single low-confidence review item; the 1,363-unit Linear transcript fell from 190.6 to 88.0 minutes with the same total of 20 review units. The post-deployment production-network acceptance reduced the 388-unit webpage from 220.5 to 94.4 writer minutes while its review count moved from 22 to 21. Local Fake-IP/private-address DNS protection was not weakened for any acceptance run.

Paginated Datalab HTML is consumed as the complete ordered set of
`.page[data-page-id]` containers rather than passed through the single-article
Readability selector. A completed response is accepted only when its quality
score, requested page IDs, page count, and image references are coherent; the
service then compares Datalab text and extracted block coverage with Poppler's
local text layer. For a PDF-related release, staged acceptance must exercise a
real multi-page PDF without invoking OpenRouter or creating a WeChat draft and
must confirm requested/processed pages plus figure/table counts in the manifest.

For original analysis, text-layer PDFs can fall back to Poppler `pdftotext`;
scanned PDFs still require Datalab OCR. Public Google Docs and GitHub
repositories work without access tokens. Configure the optional read-only
credentials above only for private material; the service exchanges the Google
refresh token for short-lived access tokens automatically.

The application does not enforce a public-IP allowlist and does not reject
proxy environment variables. Outbound routing follows the host and Node.js
runtime configuration. The health endpoint exposes aggregate queue and resource-gate counts only and
should remain on loopback or behind an authenticated monitoring agent.

## Opening Digest OIC browser state

The Opening Digest reads the OIC Trending Options Volume table through an
authorized browser session. The current public iVolatility embed does not
require an account login, so a protected empty Playwright storage-state file is
sufficient. Keep it owned by `root:zenbot` with mode `0640`.

The production flow extracts the iframe table as structured DOM data and uses a
same-session screenshot only as a consistency checkpoint; the screenshot is
discarded and never uploaded to Customer.io. The newsletter contains a
responsive HTML table. Any OIC authorization, session, browser, page, or data
validation failure omits the entire options section and records the diagnostic
in the run trace; it does not pause or block the newsletter. During the test
phase the code still fails closed when a successfully-read configured segment
name does not normalize to `test1`.

If the provider later requires login, do not put an OIC password in the
environment. Install the optional GUI helpers only on the Droplet, bind them to
loopback, and use an SSH tunnel from an operator workstation:

```bash
sudo apt-get install -y xvfb x11vnc novnc
sudo -u zenbot Xvfb :99 -screen 0 1440x1200x24 &
sudo -u zenbot x11vnc -display :99 -localhost -nopw &
ssh -L 5900:127.0.0.1:5900 your-user@your-droplet
```

Open `vnc://127.0.0.1:5900` locally, then run this in a second SSH session with
`DISPLAY=:99` and the protected service environment. Complete OIC login/MFA in
the temporary browser and press Enter only after the full table is visible:

```bash
sudo systemd-run --wait --pipe --collect --uid=zenbot \
  --property=EnvironmentFile=/etc/zen-content-hub/zen-content-hub.env \
  --setenv=DISPLAY=:99 \
  /usr/bin/node /opt/zen-content-hub/scripts/auth-oic-session.mjs
```

Set `/etc/zen-content-hub/oic-storage-state.json` to `root:zenbot` and `0640`,
then stop Xvfb/x11vnc. Never expose VNC/noVNC on a public interface.

## Opening Digest release acceptance

After an Opening Digest release is active, require `/ready` to show an idle
queue before running the acceptance command. It starts no Slack socket-mode
consumer and uses an isolated run directory, but exercises live research,
market metrics, optional OIC/cover rendering, and Customer.io:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=zen-content-hub-opening-acceptance \
  --uid=zenbot \
  --property=WorkingDirectory=/opt/zen-content-hub \
  --property=EnvironmentFile=/etc/zen-content-hub/zen-content-hub.env \
  /usr/bin/npm run acceptance:opening-digest
```

The command immediately sends one clearly named `[TEST]` newsletter to the
configured `test1` segment, then ensures the formal newsletter for the current
ET date exists and is scheduled for 10:30 ET or sent immediately when late. An
existing matching formal newsletter is reused and never duplicated. The same
run also exercises the 72-ticker universe quote scan, grouped Exa research and
the reusable OIC artifact. The final JSON line reports the deployed commit,
content mode, source count, quote coverage, price-mover/OIC/IV counts, both
Customer.io IDs, both WeChat media IDs/readback states, trace path, and any soft diagnostics. Soft diagnostics do not
produce Slack warnings; a hard gate or execution failure exits non-zero and is
handled as a release failure.

Create the service account and data/configuration directories. Copy `.env.example`
to `/etc/zen-content-hub/zen-content-hub.env`, fill it without committing
secrets, and restrict ownership before starting the service:

```bash
sudo useradd --system --home /var/lib/zen-content-hub --shell /usr/sbin/nologin zenbot
sudo install -d -o zenbot -g zenbot -m 0750 /var/lib/zen-content-hub
sudo install -d -o root -g zenbot -m 0750 /etc/zen-content-hub
sudo install -o root -g zenbot -m 0640 .env.example /etc/zen-content-hub/zen-content-hub.env
sudo chown -R zenbot:zenbot /opt/zen-content-hub
```

Before enabling Discord delivery, put the webhook URL in the protected service
environment and run this read-only target check from the active release:

```bash
cd /opt/zen-content-hub
sudo -u zenbot env DOTENV_CONFIG_PATH=/etc/zen-content-hub/zen-content-hub.env npm run check:discord
```

The command fetches webhook metadata but does not post a message. Copy the
reported `channel_id` into `DISCORD_OPENING_DIGEST_CHANNEL_ID`, rerun the check,
then set `DISCORD_OPENING_DIGEST_ENABLED=true`. On the first release, add
`--sync-discord-config` to the normal activation command. It reads the five
Discord values only from the gitignored local `.env`, transfers them in a
permission-restricted temporary file, validates the live webhook without
posting, and removes the file. Later deployments preserve those values unless
the flag is explicitly supplied again; the webhook secret is never accepted as
a command-line argument or printed. Restart only through the normal deployment
flow so the single-instance rule remains intact.

Install and start the unit after reviewing all paths and configuration:

```bash
sudo cp deploy/zen-content-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zen-content-hub
sudo systemctl status zen-content-hub
curl --fail http://127.0.0.1:8080/health
```

## Manual recovery and implementation details

The automated command above is the normal update path. The details below are
the authoritative recovery reference if automation stops and an operator must
inspect or roll back the partially staged release. Production uses an immutable
release directory rather than an in-place Git checkout.

Before activation:

1. Run the SQLite-aware backup service and verify that a new snapshot exists.
2. Confirm `/ready` reports `active=0`, `pending=0`, Slack connected and
   `ok=true`.
3. Confirm the rollback destination does not already exist.
4. Stop `zen-content-hub`, move the current directory to
   `/opt/zen-content-hub.rollback-<old-sha>`, move the staged release to
   `/opt/zen-content-hub`, and start the same systemd unit.
5. Verify `.deploy-commit`, `/ready`, one Node process and recent service logs.

SIGTERM stops new queue intake and gives the active task up to 25 seconds to
finish; queued tasks remain in SQLite and are restored by the new process. If
startup or readiness fails, restore the previous directory and protected
environment-file backup before restarting the unit.

## One-time macro release acceptance

The `macro` workflow has no cron and never sends a Slack test message. After a
new immutable release is active, first require `/ready` to report `ok=true`,
`active=0`, and `pending=0`, then confirm systemd owns exactly one service Node
process. Run the acceptance command directly in a transient unit that reads the
same protected environment file but does not start Slack or a second hub
instance:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=zen-content-hub-macro-acceptance \
  --uid=zenbot \
  --property=WorkingDirectory=/opt/zen-content-hub \
  --property=EnvironmentFile=/etc/zen-content-hub/zen-content-hub.env \
  /usr/bin/node scripts/run-macro-acceptance.mjs
```

This performs live research, V2 evidence editing, writing, sentence-level
audit, fixed-template rendering and exactly one WeChat draft creation. It does
not publish, send or schedule the draft. The final JSON line must contain a
non-empty `mediaId`, both editorial skill IDs, the selected macro archetype,
`auditApproved=true`, the article path and `researchTracePath`. Inspect the
article and trace at those exact paths, then verify the queue is still idle and
review recent service and transient-unit logs. The trace must contain routing
reason `production-direct-acceptance`, evidence boundaries, selected sources
and a non-skipped audit. Critical numeric, market-pricing and market-reaction
claims returned by the audit must have at least one supporting evidence ID in
the final selected references. Retained high-risk inferences are review
warnings, not release blockers; normal Slack-triggered tasks surface them in
the original thread.

For a local rehearsal that must not touch WeChat, use:

```bash
npm run accept:macro -- --dry-run
```

Treat readiness failure, multiple service Node processes, a failed transient
unit, missing `mediaId`, missing trace fields, skipped audit or a non-idle queue
as release failure. The release operator must immediately stop the new unit,
move the failed active directory back to its staged/failed name, restore the
previous immutable rollback directory as `/opt/zen-content-hub`, restart the
single systemd service, verify `/ready`, and stop the rollout. Preserve the
failed release directory, acceptance output, journal logs and trace for
diagnosis; do not retry against production or send a Slack test message.

## Recovering a failed translation

Use the restricted recovery command only after the target release has passed
its checks and is active. Its argument is the SQLite `runs.id`, not the
hashed run-directory name. The command rejects non-translation workflows,
tasks without a valid checkpoint, unsupported failure types and any task that
already has a `media_id`.

```bash
run_id=replace-with-database-run-id
sudo -u zenbot env \
  DB_PATH=/var/lib/zen-content-hub/runs.db \
  WORK_DIR=/var/lib/zen-content-hub/work \
  npm --prefix /opt/zen-content-hub run requeue:translation -- "$run_id"
sudo systemctl restart zen-content-hub
```

After restart, verify the same row moves from `queued` to `running` and then
to `done`, the existing checkpoint advances, and exactly one non-empty
`media_id` is stored. A changed source hash intentionally invalidates the old
checkpoint and restarts translation from the beginning.

For a V2 analysis that failed under an older release only because the WeChat
gate rejected fenced code or a four-space indented block, or because the
historical code renderer emitted safe line-break nodes outside its old final
HTML allowlist, use the separate restricted command. It accepts only `wechat`,
`sector`, `company`, or `earnings` rows with those exact errors, requires valid
Slack notification metadata, and refuses any row with a `media_id` or a
different error.

```bash
run_id=replace-with-database-run-id
sudo -u zenbot env \
  DB_PATH=/var/lib/zen-content-hub/runs.db \
  npm --prefix /opt/zen-content-hub run requeue:analysis-gate -- "$run_id"
sudo systemctl restart zen-content-hub
```

Both recovery commands only change the database row to `queued`; the one
systemd instance performs the actual work after restart.

Analysis V2 is the production default. `ANALYSIS_PIPELINE_VERSION=v1` remains
only as a single-instance emergency fallback; do not run V1 and V2 as separate
processes. Inspect `research-trace.json` during production acceptance. It records
`pipelineVersion`, the immutable task contract, bilingual search plan, evidence
matrix, editorial source classification and sentence-level audit even when a
task pauses in `needs_input`. Remove the V1 code path only in a separately
reviewed change.

Back up `/var/lib/zen-content-hub/runs.db` together with its `-wal` and `-shm`
files using a SQLite-aware snapshot or backup command. Keep only one application
instance; the local SQLite queue is not a multi-replica coordination system.
On startup, terminal runs and their isolated artifact directories older than
`RUN_RETENTION_DAYS` are removed. Back up the data directory before reducing
that value.

Install the included SQLite-aware daily snapshot timer:

```bash
sudo install -o root -g root -m 0755 deploy/zen-content-hub-backup /usr/local/sbin/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zen-content-hub-backup.timer
sudo systemctl start zen-content-hub-backup.service
sudo systemctl status zen-content-hub-backup.timer
```

Snapshots are written to `/var/lib/zen-content-hub/backups/` and retained for
14 days. Each timestamp contains a SQLite snapshot, a compressed `WORK_DIR`
artifact/checkpoint snapshot, and a SHA-256 manifest. Restore and verify the
database and artifact archive as one recovery unit. These files protect against
application-level mistakes but remain on the same Droplet; use a separately
confirmed off-host or DigitalOcean backup for Droplet-level disaster recovery,
and periodically test a restore into an isolated release directory.

Release directories and uploaded `/tmp/zen-content-hub-*.tar` archives are not
automatically pruned. Inventory them after live verification, preserve the
active directory and the rollback releases required by the current retention
decision, and remove only explicit reviewed paths. Never use a recursive
wildcard that could match `/opt/zen-content-hub`.
