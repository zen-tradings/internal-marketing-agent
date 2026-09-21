import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP systemd units separate source access, query access, tunnel credentials, and audit writes', () => {
  const exporter = read('deploy/zen-content-hub-mcp-export.service');
  const mcp = read('deploy/zen-content-hub-mcp.service');
  const tunnel = read('deploy/zen-content-hub-mcp-tunnel.service');
  assert.match(exporter, /User=zenbot/);
  assert.match(exporter, /Group=zenmcp/);
  assert.match(exporter, /ReadOnlyPaths=\/var\/lib\/zen-content-hub\/runs\.db/);
  assert.match(exporter, /InaccessiblePaths=.*zen-content-hub\/work/);
  assert.match(exporter, /CPUQuota=10%/);
  assert.match(exporter, /zen-content-hub-mcp-export\.env/);
  assert.doesNotMatch(exporter, /EnvironmentFile=.*zen-content-hub\.env(?:\s|$)/);

  assert.match(mcp, /User=zenmcp/);
  assert.match(mcp, /IPAddressDeny=any/);
  assert.match(mcp, /IPAddressAllow=localhost/);
  assert.match(mcp, /ReadOnlyPaths=\/var\/lib\/zen-content-hub-mcp/);
  assert.match(mcp, /ReadWritePaths=\/var\/log\/zen-content-hub-mcp/);
  assert.doesNotMatch(mcp, /runs\.db|EnvironmentFile=.*zen-content-hub\.env(?:\s|$)/);

  assert.match(tunnel, /User=zentunnel/);
  assert.match(tunnel, /zen-content-hub-mcp-tunnel\.env/);
  assert.doesNotMatch(tunnel, /runs\.db|ReadOnlyPaths=\/var\/lib\/zen-content-hub-mcp/);
});

test('MCP systemd units pass systemd-analyze verification when available', (t) => {
  const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return t.skip('systemd-analyze is unavailable on this host');
  assert.equal(probe.status, 0, probe.stderr);
  const files = [
    'deploy/zen-content-hub-mcp-export.service',
    'deploy/zen-content-hub-mcp-export.timer',
    'deploy/zen-content-hub-mcp.service',
    'deploy/zen-content-hub-mcp-tunnel.service',
  ].map((item) => path.join(root, item));
  const result = spawnSync('systemd-analyze', ['verify', ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

function read(filename) {
  return fs.readFileSync(path.join(root, filename), 'utf8');
}
