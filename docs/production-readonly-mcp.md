# Production business data: read-only MCP

This MCP server is an optional, isolated data product for ChatGPT. It is model-independent; a ChatGPT workspace can use it with GPT-6 Pro when that model and the app are enabled for the workspace. The integration does not change the Slack bot process, queue, publishing behavior, or production database schema.

## Security boundary

```text
runs.db (production, zenbot only)
  │ fixed indexed aggregate queries, every 5 minutes, low CPU/IO priority
  ▼
sanitized read-model.db (zenbot writes; zenmcp reads)
  │ loopback HTTP only, 1 concurrent query, bounded output
  ▼
read-only MCP process (zenmcp; no production secrets)
  │ localhost only
  ▼
OpenAI tunnel-client (zentunnel; dedicated runtime key)
  │ outbound HTTPS only
  ▼
workspace-associated Secure MCP Tunnel → ChatGPT
```

The exporter is the only component that can read `runs.db`. It stores only:

- daily counts and average durations by allowlisted workflow/source/status;
- aggregate delivery counts by allowlisted destination/status;
- current queue and pending outbox counts;
- failures mapped to fixed categories such as `timeout`, `network`, `content_gate`, or `delivery`;
- an operator-chosen server label and freshness timestamps.

It never stores prompts, message bodies, Slack users/channels, task or remote IDs, titles, raw errors, notification metadata, delivery payloads, customer/recipient data, article assets, environment values, or credentials. Unknown database dimensions become `other`; they are not copied through. There is no arbitrary-SQL tool and no per-task lookup.

The available tools are:

- `list_production_servers`
- `get_business_overview`
- `get_workflow_trends`
- `get_delivery_performance`
- `get_failure_summary`

Tool calls append two audit events (`tool_start` and `tool_finish`) containing a random request ID, tool name, allowlisted filters, outcome, duration, error code, and result byte count. Results and production values are never logged. If the audit file cannot be written, the tool fails closed.

## One-time installation on the production host

Do this only after the release containing these files has passed `npm run check` and is active. The MCP services are deliberately not enabled by the normal bot deployment; this avoids turning on a new production data path without a reviewed ChatGPT workspace and tunnel.

Create separate unprivileged identities and directories:

```bash
sudo useradd --system --home /var/lib/zen-content-hub-mcp --create-home --shell /usr/sbin/nologin zenmcp
sudo useradd --system --home /var/lib/zen-content-hub-tunnel --create-home --shell /usr/sbin/nologin zentunnel
sudo install -d -o zenbot -g zenmcp -m 0750 /var/lib/zen-content-hub-mcp
sudo install -d -o zenmcp -g zenmcp -m 0700 /var/log/zen-content-hub-mcp
sudo install -d -o zentunnel -g zentunnel -m 0700 /var/lib/zen-content-hub-tunnel
```

Create `/etc/zen-content-hub/zen-content-hub-mcp-export.env` as `root:zenbot` mode `0640`. This file is intentionally non-secret and must not reuse `/etc/zen-content-hub/zen-content-hub.env`:

```dotenv
MCP_SERVER_ID=production-primary
MCP_SOURCE_DB_PATH=/var/lib/zen-content-hub/runs.db
MCP_READ_MODEL_PATH=/var/lib/zen-content-hub-mcp/read-model.db
MCP_RETENTION_DAYS=90
```

Create `/etc/zen-content-hub/zen-content-hub-mcp.env` as `root:zenmcp` mode `0640`. It contains only the paths and limits needed by the MCP process, so that process does not even inherit the source database path:

```dotenv
MCP_READ_MODEL_PATH=/var/lib/zen-content-hub-mcp/read-model.db
MCP_AUDIT_LOG_PATH=/var/log/zen-content-hub-mcp/audit.jsonl
MCP_HOST=127.0.0.1
MCP_PORT=8790
MCP_MAX_STALENESS_SECONDS=900
MCP_RATE_LIMIT_PER_MINUTE=20
MCP_MAX_CONCURRENT=1
MCP_MAX_RESULT_BYTES=65536
MCP_MAX_REQUEST_BYTES=131072
```

Install the units and log rotation policy:

```bash
sudo install -o root -g root -m 0644 deploy/zen-content-hub-mcp-export.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-mcp-export.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-mcp.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-mcp-tunnel.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/zen-content-hub-mcp-logrotate /etc/logrotate.d/zen-content-hub-mcp
sudo systemctl daemon-reload
sudo systemctl start zen-content-hub-mcp-export.service
sudo systemctl enable --now zen-content-hub-mcp-export.timer zen-content-hub-mcp.service
curl --fail http://127.0.0.1:8790/readyz
```

The exporter runs with `Nice=10`, idle I/O scheduling, a 10% CPU quota, a 192 MB memory limit, a 100 ms SQLite busy timeout, and indexed/bounded queries. The MCP process has a 20% CPU quota and 192 MB memory limit. These are independent of the bot's application concurrency and cannot publish, enqueue, or mutate data.

## Connect ChatGPT through Secure MCP Tunnel

Use the current `tunnel-client` download from OpenAI Platform tunnel settings; do not pin a binary copied from an unrelated source. Create a tunnel associated with exactly the target Platform organization and ChatGPT workspace. Grant operators only Tunnels Read + Use; reserve Manage for the administrators who create or edit the tunnel.

Keep the tunnel runtime API key only in `/etc/zen-content-hub/zen-content-hub-mcp-tunnel.env` as `root:zentunnel` mode `0640`:

```dotenv
CONTROL_PLANE_API_KEY=replace-with-dedicated-tunnel-runtime-key
```

Initialize the profile as the isolated tunnel user. The profile points to loopback; it does not receive filesystem permission for the read model or audit log:

```bash
sudo -u zentunnel env HOME=/var/lib/zen-content-hub-tunnel sh -c '
  set -a
  . /etc/zen-content-hub/zen-content-hub-mcp-tunnel.env
  set +a
  exec /usr/local/bin/tunnel-client init \
    --profile zen-content-hub-production \
    --tunnel-id tunnel_replace_me \
    --mcp-server-url http://127.0.0.1:8790/mcp
'

sudo -u zentunnel env HOME=/var/lib/zen-content-hub-tunnel sh -c '
  set -a
  . /etc/zen-content-hub/zen-content-hub-mcp-tunnel.env
  set +a
  exec /usr/local/bin/tunnel-client doctor --profile zen-content-hub-production --explain
'

sudo systemctl enable --now zen-content-hub-mcp-tunnel.service
```

In ChatGPT, create a developer-mode app, choose **Tunnel**, select this tunnel, and restrict the app to the intended workspace/group. No public MCP URL or inbound firewall rule is needed. The MCP server deliberately has no local bearer secret because it is reachable only on loopback; external authorization is the tunnel's organization/workspace association and ChatGPT app policy.

## Verification and audit

After enabling the tunnel:

```bash
systemctl status zen-content-hub-mcp-export.timer zen-content-hub-mcp zen-content-hub-mcp-tunnel
curl --fail http://127.0.0.1:8790/readyz
sudo -u zenmcp tail -n 20 /var/log/zen-content-hub-mcp/audit.jsonl
sudo journalctl -u zen-content-hub-mcp-export.service -u zen-content-hub-mcp.service -u zen-content-hub-mcp-tunnel.service --since today
```

From ChatGPT, call `list_production_servers`, confirm the expected label, and verify that `asOf` is recent. Call one bounded overview query, then match its request ID and outcome in the audit log. Confirm that the response contains only aggregates and does not contain run IDs, titles, prompts, raw errors, customer data, or remote IDs.

Stop access immediately without touching the bot:

```bash
sudo systemctl disable --now zen-content-hub-mcp-tunnel.service zen-content-hub-mcp.service zen-content-hub-mcp-export.timer
```

Also unlink/disable the ChatGPT app or remove the workspace association in Platform tunnel settings. Rotate the tunnel runtime key if compromise is suspected. The production bot continues running throughout.

## Multiple production servers

The repository currently operates one production SQLite instance. The exporter supports multiple explicitly named local source databases by repeating `--source server-id=/absolute/path` and writes one combined sanitized model. Use that only on a dedicated aggregation host with read-only mounted snapshots; do not give the MCP process SSH, database-network, or cloud-control credentials. If servers cannot safely present local read-only snapshots to one host, create one tunnel/app per server and let ChatGPT call each explicitly. Do not turn this MCP server into a general network proxy.

Example for an isolated aggregation host:

```bash
node scripts/build-mcp-read-model.mjs \
  --source prod-sfo3=/mnt/prod-sfo3/runs.db \
  --source prod-nyc3=/mnt/prod-nyc3/runs.db \
  --output /var/lib/zen-content-hub-mcp/read-model.db \
  --retention-days 90
```

The source paths must be SQLite-aware snapshots. Never copy only a live `runs.db` file while its WAL is active.
