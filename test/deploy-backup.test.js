import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, 'deploy', 'zen-content-hub-backup');

test('生产备份脚本语法有效并把数据库、运行资产和校验清单作为同一恢复单元', () => {
  const source = fs.readFileSync(filename, 'utf8');
  const syntax = spawnSync('sh', ['-n', filename], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /artifacts-\$stamp\.tar\.gz/);
  assert.match(source, /backup-\$stamp\.sha256/);
  assert.match(source, /Refusing unsafe WORK_DIR/);
  assert.match(source, /sha256sum/);
});
