import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

for (const filename of sourceFiles(path.join(root, 'src'))) {
  const source = fs.readFileSync(filename, 'utf8');
  if (/\b(?:spawnSync|execFileSync|execSync)\b/.test(source)) {
    violations.push(`${path.relative(root, filename)}:生产运行时代码不得使用同步子进程`);
  }
  if (/dotenv\.config\(\s*\{[^}]*override\s*:\s*true/.test(source)) {
    violations.push(`${path.relative(root, filename)}:不得让 .env 覆盖进程/系统服务环境`);
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('架构约束检查通过');
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [filename] : [];
  });
}
