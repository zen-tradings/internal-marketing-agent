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

test('DigitalOcean deploy defaults to read-only preflight and Qwen writer settings', () => {
  assert.deepEqual(parseDeployArgs([]), {
    activate: false,
    commit: 'HEAD',
    target: '',
    model: 'qwen/qwen3.8-max',
    reasoning: 'high',
  });
  assert.equal(parseDeployArgs(['--activate', '--commit', SHA]).activate, true);
  assert.throws(() => parseDeployArgs(['--unknown']), /Unknown argument/);
});

test('embedded remote preflight and activation scripts are valid Bash', () => {
  for (const script of [PREFLIGHT_SCRIPT, ACTIVATE_SCRIPT]) {
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
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
  }));
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com;touch /tmp/x', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'high',
  }), /Invalid SSH target/);
  assert.throws(() => validateDeployInputs({
    target: 'root@example.com', commit: SHA, model: 'qwen/qwen3.8-max', reasoning: 'none',
  }), /Reasoning must be/);
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
