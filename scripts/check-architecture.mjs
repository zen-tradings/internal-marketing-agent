import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];
const graph = new Map();
for (const filename of sourceFiles(path.join(root, 'src'))) {
  const source = fs.readFileSync(filename, 'utf8');
  const executableSource = source.replace(/^\s*\/\/.*$/gm, '');
  const relative = path.relative(root, filename).split(path.sep).join('/');
  const reject = (message) => violations.push(`${relative}: ${message}`);
  if (/\b(?:spawnSync|execFileSync|execSync)\b/.test(source)) reject('生产运行时代码不得使用同步子进程');
  if (/dotenv\.config\(\s*\{[^}]*override\s*:\s*true/.test(source)) reject('不得让 .env 覆盖进程/系统服务环境');
  if (/wechatPublisher\.[\w]+\s*=/.test(source) && relative !== 'src/lib/adapters/wechat-publisher.js') reject('第三方全局替换只能在微信适配层安装');
  if (/rejectUnauthorized\s*:\s*false/.test(source)) reject('不得关闭 TLS 证书校验');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(executableSource)) reject('不得执行动态输入代码');
  // Follow actual static import/re-export and literal dynamic-import edges. The
  // project uses native ESM; no inferred filename/layer-name heuristics for cycles.
  const edges = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)(['"])(\.[^'"]+)\1/g)]
    .map(match => path.resolve(path.dirname(filename), match[2]));
  graph.set(filename, edges);
  for (const target of edges) {
    if (!fs.existsSync(target)) reject(`依赖文件不存在: ${path.relative(root, target)}`);
    if (relative.startsWith('src/lib/') && /\/src\/(?:core|workflows|channels|triggers)\//.test(target)) reject('lib 不得反向依赖业务装配层');
    if (relative.startsWith('src/config/') && /\/src\/(?:core|workflows|channels|triggers)\//.test(target)) reject('config 不得反向依赖业务装配层');
    if (relative !== 'src/index.js' && target === path.join(root, 'src/index.js')) reject('业务模块不得导入启动入口');
    if (relative.startsWith('src/core/writer/') && target.endsWith('/src/core/runner.js')) reject('写作子模块不得导入兼容入口');
  }
  if (relative === 'src/lib/translation/acquisition.js' && /\b(?:fetch|fetchFn)\s*\(/.test(source)) reject('不可信原文必须经安全网络入口获取');
}
const visited = new Set();
function visit(file, stack = []) {
  if (stack.includes(file)) {
    violations.push(`循环依赖: ${[...stack.slice(stack.indexOf(file)), file].map(f => path.relative(root, f)).join(' → ')}`);
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  for (const next of graph.get(file) || []) visit(next, [...stack, file]);
}
for (const file of graph.keys()) visit(file);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log(`架构约束检查通过: ${graph.size} 个模块，依赖无环`);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [filename] : [];
  });
}
