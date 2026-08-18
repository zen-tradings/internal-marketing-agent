import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVATE_SCRIPT,
  DEPLOY_MANAGED_ENV_KEYS,
  PREFLIGHT_SCRIPT,
  loadDeployTarget,
  loadDiscordDeployConfig,
  parseDeployArgs,
  parsePreflight,
  validateDeployInputs,
  unmanagedEnvironmentText,
} from '../scripts/deploy-digitalocean.mjs';

const SHA = 'a'.repeat(40);

test('DigitalOcean deploy defaults to read-only preflight and preserves Opening Digest settings unless explicitly overridden', () => {
  assert.deepEqual(parseDeployArgs([]), {
    activate: false,
    commit: 'HEAD',
    target: '',
    model: 'qwen/qwen3.8-max',
    reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3',
    plannerReasoning: 'high',
    maxConcurrency: 2,
    openingDigestModel: undefined,
    openingDigestWechatEnabled: undefined,
    openingDigestSegmentId: 0,
    syncDiscordConfig: false,
  });
  assert.equal(parseDeployArgs(['--activate', '--commit', SHA]).activate, true);
  assert.equal(parseDeployArgs(['--opening-digest-segment-id', '19']).openingDigestSegmentId, '19');
  assert.equal(parseDeployArgs(['--opening-digest-wechat-enabled', 'true']).openingDigestWechatEnabled, 'true');
  assert.equal(parseDeployArgs(['--opening-digest-model', 'openai/gpt-oss-20b']).openingDigestModel, 'openai/gpt-oss-20b');
  assert.equal(parseDeployArgs(['--max-concurrency', '1']).maxConcurrency, '1');
  assert.equal(parseDeployArgs(['--sync-discord-config']).syncDiscordConfig, true);
  assert.throws(() => parseDeployArgs(['--unknown']), /Unknown argument/);
});

test('embedded remote preflight and activation scripts are valid Bash', () => {
  for (const script of [PREFLIGHT_SCRIPT, ACTIVATE_SCRIPT]) {
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(ACTIVATE_SCRIPT, /python3 -m venv "\$stage\/\.venv"/);
  assert.match(ACTIVATE_SCRIPT, /requirements-qdii\.lock/);
  assert.match(ACTIVATE_SCRIPT, /check-qdii-python\.mjs/);
  assert.match(ACTIVATE_SCRIPT, /check-opening-digest-python\.mjs/);
  assert.match(ACTIVATE_SCRIPT, /update_env OPENING_DIGEST_WECHAT_ENABLED/);
  assert.match(ACTIVATE_SCRIPT, /update_env OPENING_DIGEST_MODEL/);
  assert.match(ACTIVATE_SCRIPT, /update_env MAX_CONCURRENCY "\$max_concurrency"/);
  assert.match(ACTIVATE_SCRIPT, /update_env BROWSER_CONCURRENCY 1/);
  assert.match(ACTIVATE_SCRIPT, /update_env WECHAT_WRITE_CONCURRENCY 1/);
  assert.match(ACTIVATE_SCRIPT, /update_env CUSTOMERIO_WRITE_CONCURRENCY 1/);
  assert.match(ACTIVATE_SCRIPT, /update_env OPENROUTER_CONCURRENCY 2/);
  assert.match(ACTIVATE_SCRIPT, /update_env EXA_SEARCH_QPS 8/);
  assert.match(ACTIVATE_SCRIPT, /update_env SLACK_POST_INTERVAL_MS 1000/);
  assert.match(ACTIVATE_SCRIPT, /env_without_managed_after/);
  assert.match(ACTIVATE_SCRIPT, /update_env QDII_ENABLED true/);
  assert.match(ACTIVATE_SCRIPT, /QDII_PYTHON_PATH \/opt\/zen-content-hub\/\.venv\/bin\/python/);
  assert.match(ACTIVATE_SCRIPT, /QDII_WORKER_PATH \/opt\/zen-content-hub\/python\/qdii_worker\.py/);
  assert.match(ACTIVATE_SCRIPT, /update_env CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID/);
  assert.match(ACTIVATE_SCRIPT, /check-discord\.mjs/);
  assert.match(ACTIVATE_SCRIPT, /install -o root -g root -m 0755 "\$stage\/deploy\/zen-content-hub-backup" "\$backup_helper"/);
  assert.match(ACTIVATE_SCRIPT, /backup_helper_changed/);
  assert.match(ACTIVATE_SCRIPT, /deployment_failed_phase=/);
  assert.match(ACTIVATE_SCRIPT, /phase=stage-validation/);
  assert.match(ACTIVATE_SCRIPT, /discord_env_before=/);
  assert.match(ACTIVATE_SCRIPT, /discord_env_after=/);
  assert.match(ACTIVATE_SCRIPT, /test "\$discord_env_after" = "\$discord_env_before"/);
  assert.match(ACTIVATE_SCRIPT, /\[ "\$switch_started" -eq 0 \] && \[ -d "\$stage" \]/);
  assert.match(ACTIVATE_SCRIPT, /find \/var\/lib\/zen-content-hub\/backups[^\n]+backup-\*\.sha256/);
  assert.match(ACTIVATE_SCRIPT, /sha256sum -c "\$latest_backup_manifest"/);
});

test('Discord deployment config is loaded from a gitignored env file without a CLI secret', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-deploy-config-'));
  const envFile = path.join(directory, '.env');
  fs.writeFileSync(envFile, [
    'DISCORD_OPENING_DIGEST_ENABLED=true',
    'DISCORD_OPENING_DIGEST_WEBHOOK_URL=https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_1234567890',
    'DISCORD_OPENING_DIGEST_CHANNEL_ID=987654321098765432',
    'DISCORD_WEBHOOK_TIMEOUT_MS=12000',
    'DISCORD_WEBHOOK_MAX_ATTEMPTS=6',
  ].join('\n'));
  const config = loadDiscordDeployConfig({ envFile });
  assert.equal(config.DISCORD_OPENING_DIGEST_ENABLED, 'true');
  assert.equal(config.DISCORD_OPENING_DIGEST_CHANNEL_ID, '987654321098765432');
  assert.equal(config.DISCORD_WEBHOOK_TIMEOUT_MS, '12000');
  assert.throws(() => loadDiscordDeployConfig({ envFile: path.join(directory, 'missing') }), /Missing local \.env/);
  fs.writeFileSync(envFile, 'DISCORD_OPENING_DIGEST_ENABLED=false\n');
  assert.throws(() => loadDiscordDeployConfig({ envFile }), /webhook URL|must be true/);
});

test('deployment environment guard permits every managed update and rejects unrelated drift', () => {
  const before = ['UNRELATED=keep', ...DEPLOY_MANAGED_ENV_KEYS.map((key) => `${key}=old`), 'TAIL=keep'].join('\n');
  const afterManagedChanges = ['UNRELATED=keep', ...DEPLOY_MANAGED_ENV_KEYS.map((key) => `${key}=new`), 'TAIL=keep'].join('\n');
  assert.equal(unmanagedEnvironmentText(afterManagedChanges), unmanagedEnvironmentText(before));
  assert.notEqual(
    unmanagedEnvironmentText(afterManagedChanges.replace('UNRELATED=keep', 'UNRELATED=changed')),
    unmanagedEnvironmentText(before),
  );
  for (const key of DEPLOY_MANAGED_ENV_KEYS) assert.match(ACTIVATE_SCRIPT, new RegExp(`(?:\\||\\()${key}(?:\\||\\))`));
});

test('deploy target must come from an explicit DigitalOcean target file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-target-'));
  const targetFile = path.join(directory, 'target.env');
  assert.throws(() => loadDeployTarget({ targetFile }), /Missing deploy\/target\.env/);
  fs.writeFileSync(targetFile, 'ZEN_DEPLOY_PROVIDER=other\nZEN_DEPLOY_SSH_TARGET=root@example.com\n');
  assert.throws(() => loadDeployTarget({ targetFile }), /must set ZEN_DEPLOY_PROVIDER=digitalocean/);
  fs.writeFileSync(targetFile, 'ZEN_DEPLOY_PROVIDER=digitalocean\nZEN_DEPLOY_SSH_TARGET=root@203.0.113.8\n');
  assert.equal(loadDeployTarget({ targetFile }), 'root@203.0.113.8');
});

test('deployment inputs reject shell injection and invalid reasoning', () => {
  assert.doesNotThrow(() => validateDeployInputs({
    target: 'root@203.0.113.8', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high',
    maxConcurrency: 2,
    openingDigestModel: 'openai/gpt-oss-120b',
    openingDigestWechatEnabled: true,
    openingDigestSegmentId: '19',
  }));
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high',
    openingDigestModel: 'openai/gpt-oss-120b;touch', openingDigestWechatEnabled: true,
  }), /Invalid Opening Digest model id/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com;touch /tmp/x', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high',
    openingDigestWechatEnabled: true,
  }), /Invalid SSH target/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'none',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high',
    openingDigestWechatEnabled: true,
  }), /Reasoning must be/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'none',
  }), /Planner reasoning must be/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerReasoning: 'high',
    openingDigestWechatEnabled: true,
  }), /Invalid OpenRouter planner model id/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high',
    openingDigestWechatEnabled: true, openingDigestSegmentId: '-1',
  }), /segment ID must be/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
    plannerModel: 'moonshotai/kimi-k3', plannerReasoning: 'high', maxConcurrency: '3',
  }), /max concurrency must be 1 or 2/);
});

test('preflight requires DigitalOcean metadata, healthy idle service and valid marker', () => {
  const valid = [
    'provider=digitalocean',
    'droplet_id=123456',
    'region=sfo3',
    'service=active',
    `active_commit=${SHA}`,
    'ready_ok=true',
    'slack_connected=true',
    'queue_active=0',
    'queue_pending=0',
    'env_OPENROUTER_MODEL=z-ai/glm-5.2',
  ].join('\n');
  assert.equal(parsePreflight(valid).region, 'sfo3');
  assert.throws(() => parsePreflight(valid.replace('provider=digitalocean', 'provider=unknown')), /did not prove/);
  assert.throws(() => parsePreflight(valid.replace('queue_active=0', 'queue_active=1')), /queue is not idle/);
  assert.throws(() => parsePreflight(valid.replace(`active_commit=${SHA}`, 'active_commit=missing')), /deploy-commit/);
});
