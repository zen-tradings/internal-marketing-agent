import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVATE_SCRIPT,
  PREFLIGHT_SCRIPT,
  loadDeployTarget,
  parseDeployArgs,
  parsePreflight,
  validateDeployInputs,
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
    openingDigestModel: undefined,
    openingDigestWechatEnabled: undefined,
    openingDigestSegmentId: 0,
  });
  assert.equal(parseDeployArgs(['--activate', '--commit', SHA]).activate, true);
  assert.equal(parseDeployArgs(['--opening-digest-segment-id', '19']).openingDigestSegmentId, '19');
  assert.equal(parseDeployArgs(['--opening-digest-wechat-enabled', 'true']).openingDigestWechatEnabled, 'true');
  assert.equal(parseDeployArgs(['--opening-digest-model', 'openai/gpt-oss-20b']).openingDigestModel, 'openai/gpt-oss-20b');
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
  assert.match(ACTIVATE_SCRIPT, /env_without_managed_opening_after/);
  assert.match(ACTIVATE_SCRIPT, /\^\(OPENING_DIGEST_MODEL\|OPENING_DIGEST_WECHAT_ENABLED\)=/);
  assert.match(ACTIVATE_SCRIPT, /update_env QDII_ENABLED true/);
  assert.match(ACTIVATE_SCRIPT, /QDII_PYTHON_PATH \/opt\/zen-content-hub\/\.venv\/bin\/python/);
  assert.match(ACTIVATE_SCRIPT, /QDII_WORKER_PATH \/opt\/zen-content-hub\/python\/qdii_worker\.py/);
  assert.match(ACTIVATE_SCRIPT, /update_env CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID/);
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
