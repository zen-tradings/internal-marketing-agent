# Zen Content Hub Cline Rules

## Scope

This project runs the Zen Slack bot pipeline:

Slack trigger -> queue/store -> Exa research -> OpenRouter writing -> WeChat draft publishing -> Slack notification.

## Before Editing

- Read `README.md`, `src/index.js`, `src/core/runner.js`, and the specific workflow/channel file involved in the task.
- Check `git status --short` first. The worktree may contain user changes; do not revert unrelated files.
- Do not print, copy, or commit secrets from `.env`, `.env.backup`, `.env.save`, or logs.

## Runtime Rules

- The local real pipeline must use project `.env` and must not set `HUB_DRY_RUN`.
- Keep the main process direct: do not add `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` for this app.
- Before running the real pipeline, run `npm run check:openrouter`.
- For safe end-to-end tests, use `HUB_DRY_RUN=1 node src/index.js` or the existing mock channel tests.

## Code Rules

- Preserve the runner contract: `runWriter({ workflow, input, config })` writes `article.md` with `title` frontmatter and returns `{ ok, articlePath, ... }`.
- Preserve publish idempotency: once `media_id` is stored, retries must not create duplicate WeChat drafts.
- Keep network integrations injectable in tests through `fetchFn` or stubs.
- Add focused `node:test` coverage for behavior changes before changing implementation code.
- Run `npm test` before claiming a change is done.

## OpenRouter Notes

- Bot runtime credentials live in `.env` as `OPENROUTER_API_KEY`.
- Cline's own OpenRouter key is configured in the VS Code extension UI and is separate from the bot runtime key.
- A key that can fetch `/models` may still fail authenticated usage; `npm run check:openrouter` checks `/key` and a minimal completion.
