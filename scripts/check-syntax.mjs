#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts', 'test', 'tools'];
const files = roots.flatMap((root) => walk(root)).filter((file) => /\.(?:m?js)$/.test(file));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`syntax ok: ${files.length} files`);

const qdiiPython = process.env.QDII_PYTHON_PATH || path.resolve('.venv/bin/python');
if (fs.existsSync(qdiiPython)) {
  const worker = path.resolve('python/qdii_worker.py');
  const result = spawnSync(qdiiPython, ['-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))', worker], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  console.log('syntax ok: python/qdii_worker.py');
} else {
  console.log('python syntax skipped: run npm run setup:qdii to create .venv');
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
