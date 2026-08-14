import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_FILE = path.join(REPO_ROOT, 'deploy', 'target.env');
const DEFAULT_MODEL = 'qwen/qwen3.8-max';
const DEFAULT_REASONING = 'high';
const DEFAULT_PLANNER_MODEL = 'moonshotai/kimi-k3';
const DEFAULT_PLANNER_REASONING = 'high';
const DEFAULT_OPENING_DIGEST_MODEL = 'openai/gpt-oss-120b';

export const DEPLOY_MANAGED_ENV_KEYS = Object.freeze([
  'OPENING_DIGEST_WECHAT_ENABLED',
  'OPENING_DIGEST_MODEL',
  'OPENROUTER_MODEL',
  'OPENROUTER_ROUTER_MODEL',
  'OPENROUTER_PLANNER_MODEL',
  'OPENROUTER_REVIEW_MODEL',
  'OPENROUTER_REASONING_EFFORT',
  'OPENROUTER_PLANNER_REASONING_EFFORT',
  'OPENROUTER_REVIEW_REASONING_EFFORT',
  'OPENROUTER_ROUTER_REASONING_EFFORT',
  'QDII_ENABLED',
  'QDII_PYTHON_PATH',
  'QDII_WORKER_PATH',
  'QDII_WORKER_TIMEOUT_MS',
  'QDII_MAX_FUNDS_SLACK',
  'QDII_MAX_FUNDS_DRAFT',
  'QDII_STALE_MAX_DAYS',
  'QDII_MAX_REPORT_BYTES',
  'QDII_MAX_TASK_DOWNLOAD_BYTES',
  'QDII_MAX_REPORT_CANDIDATES',
  'CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID',
]);

const DEPLOY_MANAGED_ENV_PATTERN = `^(${DEPLOY_MANAGED_ENV_KEYS.join('|')})=`;

export function unmanagedEnvironmentText(value) {
  const managed = new Set(DEPLOY_MANAGED_ENV_KEYS);
  return String(value || '').split('\n').filter((line) => {
    const separator = line.indexOf('=');
    return separator < 0 || !managed.has(line.slice(0, separator));
  }).join('\n');
}

export function parseDeployArgs(argv) {
  const parsed = {
    activate: false,
    commit: 'HEAD',
    target: '',
    model: DEFAULT_MODEL,
    reasoning: DEFAULT_REASONING,
    plannerModel: DEFAULT_PLANNER_MODEL,
    plannerReasoning: DEFAULT_PLANNER_REASONING,
    // Preserve the protected production values unless an operator explicitly
    // requests a change for this release.
    openingDigestModel: undefined,
    openingDigestWechatEnabled: undefined,
    openingDigestSegmentId: 0,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--activate') parsed.activate = true;
    else if (['--commit', '--target', '--model', '--reasoning', '--planner-model', '--planner-reasoning', '--opening-digest-model', '--opening-digest-wechat-enabled', '--opening-digest-segment-id'].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      parsed[key] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

export function loadDeployTarget({ target = '', targetFile = TARGET_FILE } = {}) {
  if (target) return target;
  if (!fs.existsSync(targetFile)) {
    throw new Error('Missing deploy/target.env. Copy deploy/target.example.env and set the DigitalOcean Droplet SSH target.');
  }
  const config = dotenv.parse(fs.readFileSync(targetFile));
  if (config.ZEN_DEPLOY_PROVIDER !== 'digitalocean') {
    throw new Error('deploy/target.env must set ZEN_DEPLOY_PROVIDER=digitalocean');
  }
  if (!config.ZEN_DEPLOY_SSH_TARGET) {
    throw new Error('deploy/target.env is missing ZEN_DEPLOY_SSH_TARGET');
  }
  return config.ZEN_DEPLOY_SSH_TARGET;
}

export function validateDeployInputs({ target, commit, model, reasoning, plannerModel, plannerReasoning, openingDigestModel, openingDigestWechatEnabled, openingDigestSegmentId = 0 }) {
  if (!/^[a-z_][a-z0-9_-]*@[a-z0-9_.:-]+$/i.test(target)) {
    throw new Error('Invalid SSH target; expected user@host with no shell metacharacters');
  }
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Deploy commit must be a full 40-character SHA');
  if (typeof model !== 'string' || !/^[a-z0-9._/-]+$/i.test(model)) throw new Error('Invalid OpenRouter model id');
  if (typeof plannerModel !== 'string' || !/^[a-z0-9._/-]+$/i.test(plannerModel)) throw new Error('Invalid OpenRouter planner model id');
  if (openingDigestModel != null && (typeof openingDigestModel !== 'string' || !/^[a-z0-9._/-]+$/i.test(openingDigestModel))) {
    throw new Error('Invalid Opening Digest model id');
  }
  if (!['low', 'medium', 'high'].includes(reasoning)) {
    throw new Error('Reasoning must be low, medium, or high');
  }
  if (!['low', 'medium', 'high'].includes(plannerReasoning)) {
    throw new Error('Planner reasoning must be low, medium, or high');
  }
  if (openingDigestWechatEnabled != null && ![true, false, 'true', 'false'].includes(openingDigestWechatEnabled)) {
    throw new Error('Opening Digest WeChat enabled must be true or false');
  }
  if (!Number.isInteger(Number(openingDigestSegmentId)) || Number(openingDigestSegmentId) < 0) {
    throw new Error('Opening Digest segment ID must be a non-negative integer');
  }
}

export function parsePreflight(output) {
  const entries = Object.fromEntries(String(output || '').trim().split('\n').filter(Boolean).map((line) => {
    const splitAt = line.indexOf('=');
    if (splitAt < 1) throw new Error(`Invalid preflight line: ${line}`);
    return [line.slice(0, splitAt), line.slice(splitAt + 1)];
  }));
  if (entries.provider !== 'digitalocean' || !entries.droplet_id || !entries.region) {
    throw new Error('Remote target did not prove it is a DigitalOcean Droplet');
  }
  if (entries.service !== 'active') throw new Error(`Production service is not active: ${entries.service || 'unknown'}`);
  if (entries.ready_ok !== 'true' || entries.slack_connected !== 'true') {
    throw new Error('Production /ready is not healthy or Slack is disconnected');
  }
  if (entries.queue_active !== '0' || entries.queue_pending !== '0') {
    throw new Error(`Production queue is not idle (active=${entries.queue_active}, pending=${entries.queue_pending})`);
  }
  if (!/^[a-f0-9]{40}$/i.test(entries.active_commit || '')) {
    throw new Error('Production .deploy-commit is missing or invalid');
  }
  return entries;
}

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

export const PREFLIGHT_SCRIPT = String.raw`set -euo pipefail
metadata=http://169.254.169.254/metadata/v1
droplet_id=$(curl -fsS --max-time 3 "$metadata/id")
region=$(curl -fsS --max-time 3 "$metadata/region")
sudo -n true
env_file=/etc/zen-content-hub/zen-content-hub.env
port=$(sudo awk -F= '$1 == "HEALTH_PORT" { print $2 }' "$env_file" | tail -n 1)
test -n "$port"
ready=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/ready")
printf 'provider=digitalocean\n'
printf 'droplet_id=%s\n' "$droplet_id"
printf 'region=%s\n' "$region"
printf 'service=%s\n' "$(systemctl is-active zen-content-hub)"
printf 'active_commit=%s\n' "$(cat /opt/zen-content-hub/.deploy-commit)"
printf '%s' "$ready" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(raw);
  console.log("ready_ok=" + (value.ok === true));
  console.log("slack_connected=" + (value.slackConnected === true));
  console.log("queue_active=" + Number(value.queue?.active || 0));
  console.log("queue_pending=" + Number(value.queue?.pending || 0));
});'
for key in OPENROUTER_MODEL OPENROUTER_ROUTER_MODEL OPENROUTER_PLANNER_MODEL OPENROUTER_REVIEW_MODEL OPENROUTER_REASONING_EFFORT OPENROUTER_PLANNER_REASONING_EFFORT OPENROUTER_REVIEW_REASONING_EFFORT OPENROUTER_ROUTER_REASONING_EFFORT CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID OPENING_DIGEST_MODEL OPENING_DIGEST_WECHAT_ENABLED; do
  value=$(sudo awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$env_file" | tail -n 1)
  printf '%s=%s\n' "env_$key" "$value"
done
`;

export const ACTIVATE_SCRIPT = String.raw`set -euo pipefail
sha=$1
model=$2
reasoning=$3
planner_model=$4
planner_reasoning=$5
opening_digest_model=$6
opening_digest_wechat_enabled=$7
opening_digest_segment_id=$8
short=$(printf '%.12s' "$sha")
active=/opt/zen-content-hub
stage="/opt/zen-content-hub.release-$short"
archive="/tmp/zen-content-hub-$short.tar.gz"
env_file=/etc/zen-content-hub/zen-content-hub.env
env_backup="$env_file.pre-$short"
old_sha=$(cat "$active/.deploy-commit")
old_short=$(printf '%.12s' "$old_sha")
rollback="/opt/zen-content-hub.rollback-$old_short"
failed="/opt/zen-content-hub.failed-$short"
backup_helper=/usr/local/sbin/zen-content-hub-backup
backup_helper_backup="$backup_helper.pre-$short"
switch_started=0
env_changed=0
backup_helper_changed=0
backup_helper_had_previous=0
env_without_managed_before=$(sudo awk '$0 !~ /${DEPLOY_MANAGED_ENV_PATTERN}/' "$env_file" | sha256sum | awk '{ print $1 }')

restore_on_error() {
  status=$?
  if [ "$switch_started" -eq 1 ]; then
    sudo systemctl stop zen-content-hub || true
    if [ -d "$active" ] && [ ! -e "$failed" ]; then sudo mv "$active" "$failed" || true; fi
    if [ -d "$rollback" ]; then sudo mv "$rollback" "$active" || true; fi
  fi
  if [ "$env_changed" -eq 1 ] && [ -f "$env_backup" ]; then sudo cp -a "$env_backup" "$env_file" || true; fi
  if [ "$backup_helper_changed" -eq 1 ]; then
    if [ "$backup_helper_had_previous" -eq 1 ] && [ -f "$backup_helper_backup" ]; then
      sudo mv -f "$backup_helper_backup" "$backup_helper" || true
    else
      sudo rm -f "$backup_helper" || true
    fi
  fi
  if [ "$switch_started" -eq 1 ]; then sudo systemctl start zen-content-hub || true; fi
  exit "$status"
}
trap restore_on_error ERR

metadata=http://169.254.169.254/metadata/v1
test -n "$(curl -fsS --max-time 3 "$metadata/id")"
test -f "$archive"
test ! -e "$stage"
test ! -e "$rollback"
test ! -e "$failed"
test ! -e "$env_backup"
test ! -e "$backup_helper_backup"
for key in OPENROUTER_ROUTER_MODEL OPENROUTER_REVIEW_MODEL; do
  value=$(sudo awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$env_file" | tail -n 1)
  if [ -z "$value" ]; then
    value=$(sudo awk -F= '$1 == "OPENROUTER_MODEL" { print substr($0, index($0, "=") + 1) }' "$env_file" | tail -n 1)
  fi
  test "$value" = z-ai/glm-5.2
done
current_planner=$(sudo awk -F= '$1 == "OPENROUTER_PLANNER_MODEL" { print substr($0, index($0, "=") + 1) }' "$env_file" | tail -n 1)
if [ -z "$current_planner" ]; then
  current_planner=$(sudo awk -F= '$1 == "OPENROUTER_MODEL" { print substr($0, index($0, "=") + 1) }' "$env_file" | tail -n 1)
fi
if [ "$current_planner" != z-ai/glm-5.2 ] && [ "$current_planner" != "$planner_model" ]; then
  exit 1
fi

sudo install -d -o zenbot -g zenbot -m 0750 "$stage"
sudo tar -xzf "$archive" -C "$stage"
printf '%s\n' "$sha" | sudo tee "$stage/.deploy-commit" >/dev/null
sudo chown -R zenbot:zenbot "$stage"
sudo -u zenbot npm --prefix "$stage" ci </dev/null
python3 -c 'import sys; assert sys.version_info >= (3, 11), sys.version' </dev/null
sudo -u zenbot python3 -m venv "$stage/.venv" </dev/null
sudo -u zenbot "$stage/.venv/bin/python" -m pip install --disable-pip-version-check -r "$stage/python/requirements-qdii.lock" </dev/null
sudo -u zenbot env \
  QDII_PYTHON_PATH="$stage/.venv/bin/python" \
  QDII_WORKER_PATH="$stage/python/qdii_worker.py" \
  node "$stage/scripts/check-qdii-python.mjs" </dev/null
sudo -u zenbot env \
  OPENING_DIGEST_EARNINGS_PYTHON_PATH="$stage/.venv/bin/python" \
  OPENING_DIGEST_EARNINGS_WORKER_PATH="$stage/python/opening_digest_worker.py" \
  node "$stage/scripts/check-opening-digest-python.mjs" </dev/null
sudo -u zenbot npm --prefix "$stage" run check </dev/null

if [ -f "$backup_helper" ]; then
  sudo cp -a "$backup_helper" "$backup_helper_backup"
  backup_helper_had_previous=1
fi
sudo install -o root -g root -m 0755 "$stage/deploy/zen-content-hub-backup" "$backup_helper"
backup_helper_changed=1
before_backup_manifest=$(sudo find /var/lib/zen-content-hub/backups -maxdepth 1 -type f -name 'backup-*.sha256' -printf '%f\n' 2>/dev/null | sort | sha256sum | awk '{ print $1 }')
sudo systemctl start zen-content-hub-backup.service
after_backup_manifest=$(sudo find /var/lib/zen-content-hub/backups -maxdepth 1 -type f -name 'backup-*.sha256' -printf '%f\n' | sort | sha256sum | awk '{ print $1 }')
test "$after_backup_manifest" != "$before_backup_manifest"
latest_backup_manifest=$(sudo find /var/lib/zen-content-hub/backups -maxdepth 1 -type f -name 'backup-*.sha256' -printf '%T@ %f\n' | sort -nr | sed -n '1s/^[^ ]* //p')
test -n "$latest_backup_manifest"
(cd /var/lib/zen-content-hub/backups && sudo sha256sum -c "$latest_backup_manifest")

port=$(sudo awk -F= '$1 == "HEALTH_PORT" { print $2 }' "$env_file" | tail -n 1)
ready=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/ready")
printf '%s' "$ready" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(raw);
  if (value.ok !== true || value.slackConnected !== true || Number(value.queue?.active || 0) !== 0 || Number(value.queue?.pending || 0) !== 0) process.exit(1);
});'

update_env() {
  key=$1
  value=$2
  temporary=$(mktemp)
  sudo awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$env_file" > "$temporary"
  sudo install -o root -g zenbot -m 0640 "$temporary" "$env_file.next-$short"
  rm -f "$temporary"
  sudo mv "$env_file.next-$short" "$env_file"
}
sudo cp -a "$env_file" "$env_backup"
env_changed=1
update_env OPENING_DIGEST_WECHAT_ENABLED "$opening_digest_wechat_enabled"
update_env OPENING_DIGEST_MODEL "$opening_digest_model"
update_env OPENROUTER_MODEL "$model"
update_env OPENROUTER_ROUTER_MODEL z-ai/glm-5.2
update_env OPENROUTER_PLANNER_MODEL "$planner_model"
update_env OPENROUTER_REVIEW_MODEL z-ai/glm-5.2
update_env OPENROUTER_REASONING_EFFORT "$reasoning"
update_env OPENROUTER_PLANNER_REASONING_EFFORT "$planner_reasoning"
update_env OPENROUTER_REVIEW_REASONING_EFFORT none
update_env OPENROUTER_ROUTER_REASONING_EFFORT none
update_env QDII_ENABLED true
update_env QDII_PYTHON_PATH /opt/zen-content-hub/.venv/bin/python
update_env QDII_WORKER_PATH /opt/zen-content-hub/python/qdii_worker.py
update_env QDII_WORKER_TIMEOUT_MS 120000
update_env QDII_MAX_FUNDS_SLACK 20
update_env QDII_MAX_FUNDS_DRAFT 8
update_env QDII_STALE_MAX_DAYS 366
update_env QDII_MAX_REPORT_BYTES 31457280
update_env QDII_MAX_TASK_DOWNLOAD_BYTES 157286400
update_env QDII_MAX_REPORT_CANDIDATES 3
if [ "$opening_digest_segment_id" -gt 0 ]; then
  update_env CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID "$opening_digest_segment_id"
fi
env_without_managed_after=$(sudo awk '$0 !~ /${DEPLOY_MANAGED_ENV_PATTERN}/' "$env_file" | sha256sum | awk '{ print $1 }')
test "$env_without_managed_after" = "$env_without_managed_before"

switch_started=1
sudo systemctl stop zen-content-hub
sudo mv "$active" "$rollback"
sudo mv "$stage" "$active"
sudo systemctl start zen-content-hub

ready_ok=0
for _ in $(seq 1 45); do
  if ready=$(curl -fsS --max-time 2 "http://127.0.0.1:$port/ready" 2>/dev/null); then
    if printf '%s' "$ready" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => raw += chunk);
      process.stdin.on("end", () => {
        const value = JSON.parse(raw);
        if (value.ok !== true || value.slackConnected !== true || Number(value.queue?.active || 0) !== 0 || Number(value.queue?.pending || 0) !== 0) process.exit(1);
      });'; then ready_ok=1; break; fi
  fi
  sleep 1
done
test "$ready_ok" -eq 1
test "$(cat "$active/.deploy-commit")" = "$sha"
test "$(systemctl is-active zen-content-hub)" = active
main_pid=$(systemctl show -p MainPID --value zen-content-hub)
test "$main_pid" -gt 0
test "$(ps -o comm= -p "$main_pid" | tr -d ' ')" = node
test "$(sudo awk -F= '$1 == "OPENING_DIGEST_WECHAT_ENABLED" { print $2 }' "$env_file" | tail -n 1)" = "$opening_digest_wechat_enabled"
test "$(sudo awk -F= '$1 == "OPENING_DIGEST_MODEL" { print $2 }' "$env_file" | tail -n 1)" = "$opening_digest_model"
test "$(sudo awk -F= '$1 == "OPENROUTER_MODEL" { print $2 }' "$env_file" | tail -n 1)" = "$model"
test "$(sudo awk -F= '$1 == "OPENROUTER_REASONING_EFFORT" { print $2 }' "$env_file" | tail -n 1)" = "$reasoning"
test "$(sudo awk -F= '$1 == "OPENROUTER_PLANNER_MODEL" { print $2 }' "$env_file" | tail -n 1)" = "$planner_model"
test "$(sudo awk -F= '$1 == "OPENROUTER_PLANNER_REASONING_EFFORT" { print $2 }' "$env_file" | tail -n 1)" = "$planner_reasoning"
test "$(sudo awk -F= '$1 == "QDII_ENABLED" { print $2 }' "$env_file" | tail -n 1)" = true
test "$(sudo awk -F= '$1 == "QDII_PYTHON_PATH" { print $2 }' "$env_file" | tail -n 1)" = /opt/zen-content-hub/.venv/bin/python
test "$(sudo awk -F= '$1 == "QDII_WORKER_PATH" { print $2 }' "$env_file" | tail -n 1)" = /opt/zen-content-hub/python/qdii_worker.py
if [ "$opening_digest_segment_id" -gt 0 ]; then
  test "$(sudo awk -F= '$1 == "CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID" { print $2 }' "$env_file" | tail -n 1)" = "$opening_digest_segment_id"
fi
test -x /opt/zen-content-hub/.venv/bin/python

trap - ERR
rm -f "$archive"
printf 'deployed_commit=%s\n' "$sha"
printf 'previous_commit=%s\n' "$old_sha"
printf 'rollback=%s\n' "$rollback"
printf 'env_backup=%s\n' "$env_backup"
printf 'backup_helper_backup=%s\n' "$backup_helper_backup"
printf 'main_pid=%s\n' "$main_pid"
printf 'ready=%s\n' "$ready"
`;

export function runCommand(command, args, { input, cwd = REPO_ROOT, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    const detail = quiet ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

export function preflightRemote(target, run = runCommand) {
  const output = run('ssh', [...SSH_OPTIONS, target, 'bash -s'], { input: PREFLIGHT_SCRIPT, quiet: true });
  return parsePreflight(output);
}

export function resolveCommit(commit, run = runCommand) {
  return run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { quiet: true }).trim();
}

export function assertLocalRelease(commit, run = runCommand) {
  if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) throw new Error('Refusing to deploy a dirty working tree');
  run('git', ['merge-base', '--is-ancestor', commit, '@{upstream}'], { quiet: true });
}

export function activateRemote({ target, commit, model, reasoning, plannerModel, plannerReasoning, openingDigestModel = DEFAULT_OPENING_DIGEST_MODEL, openingDigestWechatEnabled, openingDigestSegmentId = 0 }, run = runCommand) {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-content-hub-deploy-'));
  const short = commit.slice(0, 12);
  const archive = path.join(temporaryDir, `zen-content-hub-${short}.tar.gz`);
  const remoteScript = `/tmp/zen-content-hub-activate-${short}.sh`;
  const encodedScript = Buffer.from(ACTIVATE_SCRIPT, 'utf8').toString('base64');
  try {
    run('git', ['archive', '--format=tar.gz', `--output=${archive}`, commit]);
    run('scp', [...SSH_OPTIONS, archive, `${target}:/tmp/zen-content-hub-${short}.tar.gz`]);
    return run('ssh', [
      ...SSH_OPTIONS,
      target,
      `printf '%s' '${encodedScript}' | base64 -d > ${remoteScript} && bash ${remoteScript} ${commit} ${model} ${reasoning} ${plannerModel} ${plannerReasoning} ${openingDigestModel} ${openingDigestWechatEnabled} ${openingDigestSegmentId}; status=$?; rm -f ${remoteScript}; exit $status`,
    ], { quiet: true });
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDeployArgs(argv);
  const target = loadDeployTarget(options);
  const commit = resolveCommit(options.commit);
  validateDeployInputs({ ...options, target, commit });
  assertLocalRelease(commit);
  const preflight = preflightRemote(target);
  console.log(JSON.stringify({ mode: options.activate ? 'activate' : 'preflight', target, commit, ...preflight }, null, 2));
  if (!options.activate) {
    console.log('Preflight only. Re-run with --activate to back up, stage, switch, and verify the release.');
    return;
  }
  const openingDigestModel = options.openingDigestModel
    || preflight.env_OPENING_DIGEST_MODEL
    || DEFAULT_OPENING_DIGEST_MODEL;
  const openingDigestWechatEnabled = options.openingDigestWechatEnabled
    ?? (preflight.env_OPENING_DIGEST_WECHAT_ENABLED || false);
  validateDeployInputs({
    ...options,
    target,
    commit,
    openingDigestModel,
    openingDigestWechatEnabled,
  });
  const effectiveRouterModel = preflight.env_OPENROUTER_ROUTER_MODEL || preflight.env_OPENROUTER_MODEL;
  const effectivePlannerModel = preflight.env_OPENROUTER_PLANNER_MODEL || preflight.env_OPENROUTER_MODEL;
  const effectiveReviewModel = preflight.env_OPENROUTER_REVIEW_MODEL || preflight.env_OPENROUTER_MODEL;
  if (effectiveRouterModel !== 'z-ai/glm-5.2'
    || !['z-ai/glm-5.2', options.plannerModel].includes(effectivePlannerModel)
    || effectiveReviewModel !== 'z-ai/glm-5.2') {
    throw new Error('Production model roles have drifted from the approved GLM-to-Kimi planner migration path');
  }
  const output = activateRemote({
    target,
    commit,
    model: options.model,
    reasoning: options.reasoning,
    plannerModel: options.plannerModel,
    plannerReasoning: options.plannerReasoning,
    openingDigestModel,
    openingDigestWechatEnabled,
    openingDigestSegmentId: options.openingDigestSegmentId,
  });
  console.log(output.trim());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
