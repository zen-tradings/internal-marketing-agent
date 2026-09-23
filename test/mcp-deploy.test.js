import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP systemd units separate source access, query access, tunnel credentials, and audit writes', () => {
  const exporter = read('deploy/zen-content-hub-mcp-export.service');
  const mcp = read('deploy/zen-content-hub-mcp.service');
  const tunnel = read('deploy/zen-content-hub-mcp-tunnel.service');
  assert.match(exporter, /ExecStart=\/usr\/bin\/node /);
  assert.match(exporter, /User=zenbot/);
  assert.match(exporter, /Group=zenmcp/);
  assert.match(exporter, /ReadOnlyPaths=\/var\/lib\/zen-content-hub\/runs\.db/);
  assert.match(exporter, /InaccessiblePaths=.*zen-content-hub\/work/);
  assert.match(exporter, /CPUQuota=10%/);
  assert.match(exporter, /zen-content-hub-mcp-export\.env/);
  assert.doesNotMatch(exporter, /EnvironmentFile=.*zen-content-hub\.env(?:\s|$)/);

  assert.match(mcp, /ExecStart=\/usr\/bin\/node /);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-systemd-verify-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = [
    'deploy/zen-content-hub-mcp-export.service',
    'deploy/zen-content-hub-mcp-export.timer',
    'deploy/zen-content-hub-mcp.service',
  ].map((item) => {
    // GitHub setup-node installs into its tool cache, not /usr/bin. Verify
    // copied units against the current executable without editing deployment files.
    const target = path.join(directory, path.basename(item));
    fs.writeFileSync(target, read(item).replace(/^ExecStart=\/usr\/bin\/node /m, `ExecStart=${JSON.stringify(process.execPath)} `));
    return target;
  });
  const tunnelUnit = path.join(root, 'deploy/zen-content-hub-mcp-tunnel.service');
  if (fs.existsSync('/usr/local/bin/tunnel-client')) files.push(tunnelUnit);
  const result = spawnSync('systemd-analyze', ['verify', ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  if (!fs.existsSync('/usr/local/bin/tunnel-client')) {
    t.diagnostic('optional tunnel-client is not installed; tunnel unit is verified when the client is provisioned');
  }
});

function read(filename) {
  return fs.readFileSync(path.join(root, filename), 'utf8');
}
