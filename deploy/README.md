# Linux / DigitalOcean deployment

The service is designed to run as one systemd instance. Do not start a second
manual process with the same Slack tokens or SQLite database.

## Filesystem layout

```text
/opt/zen-content-hub/          checked-out repository
/etc/zen-content-hub/          secrets and runtime configuration directory
/etc/zen-content-hub/zen-content-hub.env  service environment (0640, root:zenbot)
/var/lib/zen-content-hub/      SQLite database and per-run artifacts
```

Install Node.js 22+, Chrome/Chromium, Poppler, and a Simplified Chinese font
package such as Ubuntu's `fonts-noto-cjk`. Without the CJK font, headless Chrome
renders Chinese cover titles as empty boxes. The cover generator is versioned
in `tools/cover-generator`; run `npm ci` in `/opt/zen-content-hub` and set these
Linux-specific values (use the actual browser executable installed on the
host):

```dotenv
WORK_DIR=/var/lib/zen-content-hub/work
DB_PATH=/var/lib/zen-content-hub/runs.db
TRANSLATION_BROWSER_EXECUTABLE=/usr/bin/google-chrome
DATALAB_API_KEY=replace-with-datalab-api-key
DATALAB_MODE=balanced
CRON_TIMEZONE=America/Los_Angeles
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8080
MAX_CONCURRENCY=1
MAX_QUEUE_SIZE=100
OPENROUTER_MODEL=z-ai/glm-5.2
OPENROUTER_PLANNER_MODEL=z-ai/glm-5.2
OPENROUTER_REVIEW_MODEL=z-ai/glm-5.2
ANALYSIS_PIPELINE_VERSION=v2
ANALYSIS_SEARCH_MAX_QUERIES=6
ANALYSIS_RECENT_WINDOW_DAYS=90
SLACK_EDIT_DEBOUNCE_MS=5000
SLACK_ALLOWED_USER_IDS=U0123456789
SLACK_ALLOWED_CHANNEL_IDS=C0123456789
```

Structured HTML and arXiv HTML translation run directly in this Node.js
service. PDF translation sends the downloaded PDF to Datalab's hosted
conversion API, then immediately stores the returned images inside that run's
artifact directory before translation and rendering continue locally. The
Droplet therefore does not need Marker/MinerU models; `DATALAB_API_KEY` is
required only when a translation resolves to PDF. Keep it in the protected
service environment, never in the repository.

The application does not enforce a public-IP allowlist and does not reject
proxy environment variables. Outbound routing follows the host and Node.js
runtime configuration. The health endpoint exposes queue counts only and
should remain on loopback or behind an authenticated monitoring agent.

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

Install and start the unit after reviewing all paths and configuration:

```bash
sudo cp deploy/zen-content-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zen-content-hub
sudo systemctl status zen-content-hub
curl --fail http://127.0.0.1:8080/health
```

Before each deployment, run `npm ci && npm run check`. Deploy by pulling the
reviewed commit and running `sudo systemctl restart zen-content-hub`. SIGTERM
stops new queue intake and gives the active task up to 25 seconds to finish;
queued tasks remain in SQLite and are restored by the new process.

For the first Analysis V2 rollout, deploy the reviewed code with
`ANALYSIS_PIPELINE_VERSION=v1`, verify that the service and Slack connection
are healthy, then set it to `v2` and restart the same systemd instance. Do not
run V1 and V2 as separate processes. Inspect `research-trace.json` for the first
five WeChat analysis tasks; it records the immutable task contract, search
plan, evidence matrix, source classification and sentence-level audit even when
the task pauses in `needs_input`. Switching the single environment value back
to `v1` is the temporary rollback path.

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
14 days. They protect against application-level database mistakes but remain on
the same Droplet; use a separately confirmed off-host or DigitalOcean backup for
Droplet-level disaster recovery.
