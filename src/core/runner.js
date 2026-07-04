import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function runClaude({ workflow, input, config, spawnFn = nodeSpawn }) {
  return new Promise((resolve) => {
    const prompt = workflow.promptTemplate(input);
    const articlePath = path.join(workflow.workDir, 'article.md');
    try { fs.rmSync(articlePath, { force: true }); } catch {}

    const env = {
      ...process.env,
      // 代理仅注入子进程(Claude/Exa 出海),微信域名直连
      https_proxy: config.proxy.https || '',
      http_proxy: config.proxy.http || '',
      all_proxy: config.proxy.all || '',
      no_proxy: config.proxy.noProxy || '',
      NO_PROXY: config.proxy.noProxy || '',
    };

    const cp = spawnFn(config.claudeBin,
      ['-p', prompt, '--dangerously-skip-permissions', '--allowedTools', workflow.allowedTools.join(',')],
      { cwd: workflow.workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    cp.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => cp.kill('SIGKILL'), workflow.timeoutMs);
    cp.on('close', (code) => {
      clearTimeout(timer);
      const exists = fs.existsSync(articlePath);
      resolve({ ok: code === 0 && exists, articlePath, exitCode: code, stderr: stderr.slice(0, 600) });
    });
    cp.on('error', () => { clearTimeout(timer); resolve({ ok: false, articlePath, exitCode: -1, stderr: 'spawn error' }); });
  });
}
