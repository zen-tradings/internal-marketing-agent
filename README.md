# Zen Content Hub

Route Slack requests to WeChat drafts, Customer.io newsletter drafts, or QDII holdings replies.
Research and translation workflows read linked sources and attachments before they create a draft. A
protected Opening Digest workflow can send or schedule an email, then create a WeChat draft and
deliver a Discord post.

You can run the service on macOS for development or as one systemd process on Linux. The service
stores tasks and delivery state in SQLite.

## See what each request produces

| Workflow | Ask for | Result |
| --- | --- | --- |
| `wechat` | A general article, or an unprefixed request | WeChat draft |
| `macro` | Cross-asset macro analysis | WeChat draft |
| `company` | Company financial or competitive analysis | WeChat draft |
| `earnings` | An earnings preview or review | WeChat draft |
| `sector` | Industry or sector analysis | WeChat draft |
| `morning` | A short morning brief | WeChat draft |
| `translate` | A faithful translation of the first link | WeChat draft |
| `email` | A newsletter or email | Customer.io draft |
| `qdii` | Holdings for a six-digit QDII fund code | Slack reply |
| `opening-digest` | The U.S. market opening digest | Protected Customer.io email |

You can use a workflow prefix such as `macro:`, `translate:`, or `email:`. You can also describe the
task in natural language. The bot uses the full Slack request and accepts supported links, PDFs, and
text attachments. It writes WeChat articles and translations in Simplified Chinese by default. It
writes newsletters and QDII replies in English unless you request another language.

Ordinary WeChat and Customer.io workflows create drafts only. The Opening Digest is a controlled
exception. A formal cron run sends or schedules email to its protected audience. After email
succeeds, enabled WeChat delivery creates a Chinese draft. Enabled Discord delivery uses the same
frozen content for formal cron runs only. A manual Slack run uses an isolated test audience and
never posts to Discord.

## Set up your local instance

Use Node.js 22 or later. Configure OpenRouter, Slack, and WeChat credentials for the core service.
Add Exa for original research and a Customer.io App API key for newsletter workflows. Use Python
3.11+ for QDII holdings. Install Poppler to read searchable PDFs and configure Datalab for scanned
PDFs or structured PDF translation.

```bash
npm ci
cp .env.example .env
```

Set `WORK_DIR` and `DB_PATH` to writable local paths. Fill in the credentials you need in `.env`.
Keep `.env`, task databases, and generated content out of Git. Run `npm run setup:qdii` if you
enable QDII holdings.

Give your Slack app the `files:read` Bot Token scope before you use private Slack attachments.
Reinstall the app after you change its scopes. Without this scope, Slack can return a login page
instead of an attached PDF.

For private Notion pages, Google Docs, or Linear issues, configure read-only access and share each
source with the integration. Follow the [private document setup guide](docs/private-documents.md). A
task stops if it cannot read a private source you supplied.

## Run and check the service

Run the required check before you start or deploy changed code:

```bash
npm run check
```

This checks syntax and architecture, runs offline tests, and audits production dependencies for
high-severity issues. The dependency audit needs access to the npm registry. Run live connection
checks when you configure or change the corresponding service:

```bash
npm run check:openrouter
npm run check:documents -- "<private-document-url>"
npm run check:customerio
```

Start one local instance:

```bash
npm start
```

Use a rehearsal when you want to exercise research and writing without creating a real draft or
sending an email:

```bash
HUB_DRY_RUN=1 npm start
```

A rehearsal uses a separate database and task directory. It can still call research and model
services and send Slack notifications. Stop any launchd or systemd instance that uses the same Slack
tokens before you start a manual instance. Two instances can consume the same Slack messages.

For persistent macOS runs and logs, follow the [developer guide](docs/GUIDE.md). Code and `.env`
changes take effect only after you check and restart the service.

## Send and inspect a Slack task

Send the bot a direct message or mention it in an allowed channel. In production, set
`SLACK_ALLOWED_USER_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, and `SLACK_RATE_LIMIT_PER_MINUTE` before
accepting requests.

For example, send `macro: Explain how a rate decision could affect equities and bonds` or
`translate: Translate the first 5 pages of https://example.com/paper.pdf`. A bare link starts WeChat
analysis; it does not request translation. To cancel, send `stop the current task` in the original
task thread. The bot will not force-stop a task after a remote draft creation may have started.

Inspect task status or the sources selected for a run:

```bash
npm run status
npm run trace:research -- company
```

If you need to recover a failed run, use the restricted commands in the
[deployment guide](deploy/README.md). Do not edit SQLite task states by hand or retry an uncertain
publish operation.

## Find the code you need

| To change | Start here |
| --- | --- |
| Service assembly and lifecycle | `src/index.js` |
| Environment defaults and startup checks | `src/config/index.js` |
| Slack and cron triggers | `src/triggers/` |
| Task types and prompts | `src/workflows/` |
| Queue, SQLite, research, writing, and notifications | `src/core/` |
| WeChat and Customer.io draft channels | `src/channels/` |
| Network gates, translation, and rendering | `src/lib/` |
| Versioned writing methods | `skills/` |

Register a new workflow in `src/index.js` after you add it under `src/workflows/`. Register a real
draft channel and its locked template in `src/lib/draft-template.js`. A task cannot override a
channel's template. Bump the template version and update rendering tests when you change its layout.

Keep every run in its own directory through `runWorkDir()`. Pass untrusted URLs through
`safeFetchResource()` so redirects, private addresses, and download limits receive the same checks.
Record a remote write before you send it. If its result is uncertain, reconcile it with read-only
calls or mark it `needs_review`; do not issue a second create or send request.

Use the [developer guide](docs/GUIDE.md) for the detailed code map and extension points.

## Deploy to production

Run one process against one SQLite database. Set `MAX_QUEUE_SIZE` explicitly. On the validated 1
vCPU / 2 GB host, use `MAX_CONCURRENCY=2`; do not exceed two. Protect production Slack access with
user and channel allowlists.

Deploy only through `npm run deploy:digitalocean`. Set the target in the untracked
`deploy/target.env`; the deploy command verifies that it is a DigitalOcean Droplet. It stages and
checks a separate release before switching the single systemd instance. Do not overwrite the active
`/opt/zen-content-hub` release or restart the service before checks pass.

Health endpoints are off by default. If you enable them, bind them to loopback. `/health` checks the
process and local state; `/ready` also requires a Slack Socket Mode connection. Pending
notifications survive Slack outages in SQLite.

Follow the [deployment and recovery guide](deploy/README.md) for installation, backups, health
checks, release activation, and rollback. Use the
[newsletter rollout guide](docs/NEWSLETTER_ROLLOUT.md) for Customer.io audiences and Opening Digest
acceptance. The optional [production read-only MCP guide](docs/production-readonly-mcp.md) explains
how to expose aggregate metrics without exposing task content.
