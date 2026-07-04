# Zen Content Hub 引擎(子项目 A)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `zen-slack-bot` 单文件重构为模块化内容编排引擎,先接入微信渠道,发布归属改为 Node 侧用 `@wenyan-md/core` 渲染+发布(media_id 来自返回值而非解析 stdout)。

**Architecture:** 常驻国内 VPS 的 Node(ESM)单进程。触发器(Slack/cron)把任务入队(SQLite 持久化)→ runner spawn `claude -p` 只做调研+写作产出 `article.md` → channel 用 `renderAndPublish` 渲染并发布到微信草稿 → 名片注入 → Slack 回报。微信调用在主进程(直连),Claude/Exa 在子进程(走代理),代理污染按进程边界隔离。

**Tech Stack:** Node ≥ 24(ESM),`@slack/bolt`(Socket Mode),`better-sqlite3`(同步),`node-cron`,`@wenyan-md/core@3.0.10`(锁定),`node:test`(内置测试,`node --test`)。

## Global Constraints

- **ESM**:`package.json` 设 `"type": "module"`;全部用 `import`(现有 CJS `bot.js` 仅作迁移参考)。
- **渲染 parity**:必须调用 `@wenyan-md/core/wrapper` 的 `renderAndPublish`,渲染参数原样复刻:`{ theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true }`。`@wenyan-md/core` 版本精确锁 `3.0.10`(不用 `^`)。
- **主题**:复用现有 `~/.config/wenyan-md/`(已注册 `zen-trading` → `themes/zen-trading.css`);引擎不改动该目录,只读。
- **网络**:微信 API 调用所在的**主进程不得设置 `https_proxy/http_proxy/all_proxy`**;这些代理变量**只**注入到 Claude 子进程 env。微信域名进 `no_proxy`。
- **微信凭据**:`WECHAT_APP_ID` / `WECHAT_APP_SECRET` 走环境变量(主进程 env),不进 git;`renderAndPublish` 本地模式不传 `appId`。
- **密钥**:`.env`、日志、`node_modules/` 已在 `.gitignore`;禁止提交任何密钥。
- **提交**:每个 Task 末尾提交一次,message 用 `feat:`/`test:`/`chore:` 前缀。

---

## File Structure

```
zen-content-hub/                 (现 ~/zen-slack-bot)
├── package.json                 type:module + deps + scripts(start / test)
├── src/
│   ├── config/index.js          读 env + 默认值(代理/超时/并发/路径)
│   ├── core/
│   │   ├── store.js             SQLite runs 表 CRUD(better-sqlite3)
│   │   ├── queue.js             限并发队列,基于 store 状态
│   │   ├── runner.js            spawn claude,注入 prompt/工具/代理 env,超时,产出校验
│   │   └── notifier.js          Slack 回报(唯一出 Slack 的地方)
│   ├── triggers/
│   │   ├── slack.js             Socket Mode → enqueue(迁移自 bot.js)
│   │   └── cron.js              node-cron → enqueue
│   ├── workflows/
│   │   └── wechat.js            微信工作流声明式配置 + promptTemplate
│   ├── channels/
│   │   ├── mock.js              测试/ dry-run 用假渠道
│   │   └── wechat-draft.js      renderAndPublish + 封面 + 名片注入
│   ├── lib/
│   │   ├── getInputContent.js   core 要求的读文件函数
│   │   ├── wechatApi.js         直连微信 token/getaccountbasicinfo/draft get·update
│   │   └── cover.js             调 ~/zen-push-image 生成封面
│   └── index.js                 启动装配
├── test/                        node:test 用例 + fixtures + golden
│   ├── fixtures/
│   └── golden/
├── deploy/                      systemd unit / .env.example / 部署 README
└── docs/superpowers/            spec + 本 plan
```

---

## Task 1: 项目脚手架 + 配置层

**Files:**
- Modify: `package.json`
- Create: `src/config/index.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig() → { workDir, dbPath, claudeBin, maxConcurrency, defaultTimeoutMs, proxy:{https,http,all,noProxy}, slack:{botToken,appToken,notifyChannel}, wechat:{appId,appSecret} }`

- [ ] **Step 1: 改 package.json 为 ESM + 依赖 + 脚本**

```json
{
  "name": "zen-content-hub",
  "version": "2.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "@slack/bolt": "^3.17.0",
    "@wenyan-md/core": "3.0.10",
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.3.1",
    "node-cron": "^3.0.3"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `cd ~/zen-slack-bot && npm install`
Expected: 无报错,`node_modules/@wenyan-md/core` 版本为 `3.0.10`(`npm ls @wenyan-md/core` 确认)。

- [ ] **Step 3: 写失败测试 test/config.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('loadConfig 读取 env 并给出默认值', () => {
  const env = {
    WORK_DIR: '/srv/zen',
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', NOTIFY_CHANNEL_ID: 'C1',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
  };
  const c = loadConfig(env);
  assert.equal(c.workDir, '/srv/zen');
  assert.equal(c.maxConcurrency, 1);              // 默认
  assert.equal(c.defaultTimeoutMs, 600000);       // 默认 10min
  assert.equal(c.proxy.https, 'http://127.0.0.1:7897');
  assert.ok(c.proxy.noProxy.includes('weixin.qq.com'));
  assert.equal(c.wechat.appId, 'wx');
});

test('缺关键 env 抛错', () => {
  assert.throws(() => loadConfig({}), /SLACK_BOT_TOKEN/);
});
```

- [ ] **Step 4: 运行,确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL(`loadConfig` 未定义 / 模块不存在)。

- [ ] **Step 5: 实现 src/config/index.js**

```js
export function loadConfig(env = process.env) {
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    workDir: env.WORK_DIR || '/srv/zen/wechat',
    dbPath: env.DB_PATH || `${env.HOME || '.'}/zen-content-hub/runs.db`,
    claudeBin: env.CLAUDE_BIN || '/Users/clarachen/.local/bin/claude',
    maxConcurrency: Number(env.MAX_CONCURRENCY || 1),
    defaultTimeoutMs: Number(env.DEFAULT_TIMEOUT_MS || 10 * 60 * 1000),
    proxy: {
      https: env.HTTPS_PROXY || '',
      http: env.HTTP_PROXY || '',
      all: env.ALL_PROXY || '',
      noProxy: env.NO_PROXY || 'api.weixin.qq.com,mp.weixin.qq.com',
    },
    slack: {
      botToken: need('SLACK_BOT_TOKEN'),
      appToken: need('SLACK_APP_TOKEN'),
      notifyChannel: env.NOTIFY_CHANNEL_ID || '',
    },
    wechat: { appId: need('WECHAT_APP_ID'), appSecret: need('WECHAT_APP_SECRET') },
  };
}
```

- [ ] **Step 6: 运行,确认通过**

Run: `node --test test/config.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json src/config/index.js test/config.test.js
git commit -m "feat: ESM 脚手架 + 配置层"
```

---

## Task 2: SQLite 状态存储(store.js)

**Files:**
- Create: `src/core/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `openStore(dbPath) → store`
  - `store.createRun({id, workflowId, source, input, notify}) → void`(status 初始为 `queued`)
  - `store.setStatus(id, status, patch={})` —— patch 可含 `{stage,title,mediaId,error,startedAt,finishedAt}`
  - `store.getRun(id) → row | undefined`
  - `store.listByStatus(status) → row[]`
  - `store.markInterrupted() → number`(把残留 `running` 全置 `interrupted`,返回条数)
  - 行字段:`id, workflow_id, source, input, status, stage, title, media_id, error, notify_json, created_at, started_at, finished_at`

- [ ] **Step 1: 写失败测试 test/store.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';

test('createRun / getRun / setStatus 流转', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'r1', workflowId: 'wechat', source: 'slack', input: '写英伟达', notify: { channel: 'C1', ts: '1.1' } });
  let r = s.getRun('r1');
  assert.equal(r.status, 'queued');
  assert.equal(JSON.parse(r.notify_json).channel, 'C1');

  s.setStatus('r1', 'running', { startedAt: 111 });
  s.setStatus('r1', 'done', { title: 'T', mediaId: 'M', finishedAt: 222 });
  r = s.getRun('r1');
  assert.equal(r.status, 'done');
  assert.equal(r.media_id, 'M');
  assert.equal(r.title, 'T');
});

test('markInterrupted 把 running 置 interrupted', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'a', workflowId: 'w', source: 'slack', input: 'x', notify: {} });
  s.setStatus('a', 'running', {});
  assert.equal(s.markInterrupted(), 1);
  assert.equal(s.getRun('a').status, 'interrupted');
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/core/store.js**

```js
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  source TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  title TEXT,
  media_id TEXT,
  error TEXT,
  notify_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
`;

export function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return {
    createRun({ id, workflowId, source, input, notify }) {
      db.prepare(
        `INSERT INTO runs (id, workflow_id, source, input, status, notify_json, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`
      ).run(id, workflowId, source, input, JSON.stringify(notify ?? {}), Date.now());
    },
    setStatus(id, status, patch = {}) {
      const cols = { status, stage: patch.stage, title: patch.title,
        media_id: patch.mediaId, error: patch.error,
        started_at: patch.startedAt, finished_at: patch.finishedAt };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(cols)) {
        if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
      }
      vals.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    getRun(id) { return db.prepare('SELECT * FROM runs WHERE id = ?').get(id); },
    listByStatus(status) { return db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at').all(status); },
    markInterrupted() {
      return db.prepare(`UPDATE runs SET status = 'interrupted' WHERE status = 'running'`).run().changes;
    },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/store.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/core/store.js test/store.test.js
git commit -m "feat: SQLite 状态存储 store.js"
```

---

## Task 3: 限并发任务队列(queue.js)

**Files:**
- Create: `src/core/queue.js`
- Test: `test/queue.test.js`

**Interfaces:**
- Consumes: `store`(Task 2)
- Produces:
  - `createQueue({ store, maxConcurrency, handler }) → queue`,`handler(run) → Promise<void>`
  - `queue.enqueue({ id, workflowId, source, input, notify }) → void`(写 store 并触发调度)
  - 保证并发不超过 `maxConcurrency`;handler 抛错不影响队列继续。

- [ ] **Step 1: 写失败测试 test/queue.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';

test('并发受限 + 全部处理', async () => {
  const store = openStore(':memory:');
  let active = 0, maxSeen = 0;
  const order = [];
  const handler = async (run) => {
    active++; maxSeen = Math.max(maxSeen, active);
    await new Promise(r => setTimeout(r, 10));
    order.push(run.id); active--;
  };
  const q = createQueue({ store, maxConcurrency: 2, handler });
  for (const id of ['a', 'b', 'c', 'd']) q.enqueue({ id, workflowId: 'w', source: 'slack', input: id, notify: {} });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(order.length, 4);
  assert.ok(maxSeen <= 2, `并发应 ≤2,实际 ${maxSeen}`);
});

test('handler 抛错不卡死队列', async () => {
  const store = openStore(':memory:');
  const done = [];
  const q = createQueue({ store, maxConcurrency: 1, handler: async (run) => {
    if (run.id === 'bad') throw new Error('boom');
    done.push(run.id);
  }});
  q.enqueue({ id: 'bad', workflowId: 'w', source: 's', input: 'x', notify: {} });
  q.enqueue({ id: 'ok', workflowId: 'w', source: 's', input: 'y', notify: {} });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(done, ['ok']);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/queue.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/core/queue.js**

```js
export function createQueue({ store, maxConcurrency = 1, handler }) {
  const pending = [];
  let active = 0;

  function schedule() {
    while (active < maxConcurrency && pending.length) {
      const run = pending.shift();
      active++;
      Promise.resolve()
        .then(() => handler(run))
        .catch((e) => { /* handler 内部已负责落库/告警 */ console.error(`[queue] run ${run.id} 失败:`, e?.message); })
        .finally(() => { active--; schedule(); });
    }
  }

  return {
    enqueue(task) {
      store.createRun(task);
      pending.push(task);
      schedule();
    },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/queue.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/core/queue.js test/queue.test.js
git commit -m "feat: 限并发任务队列 queue.js"
```

---

## Task 4: Claude 执行器(runner.js)

**Files:**
- Create: `src/core/runner.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: `config`(Task 1)
- Produces:
  - `runClaude({ workflow, input, config, spawnFn=spawn }) → Promise<{ ok, articlePath, exitCode, stderr }>`
  - 行为:在 `workflow.workDir` 下 spawn `claude -p <prompt> --dangerously-skip-permissions --allowedTools <...>`,env = 主 env + 代理变量(仅子进程)+ `no_proxy`;超时 `workflow.timeoutMs` 后 SIGKILL;结束后校验退出码为 0 且 `article.md` 存在。`spawnFn` 可注入以便测试。

- [ ] **Step 1: 写失败测试 test/runner.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from '../src/core/runner.js';

function fakeSpawn(behavior) {
  return (bin, args, opts) => {
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.kill = () => cp.emit('close', 137);
    cp._args = args; cp._opts = opts;
    queueMicrotask(() => behavior(cp, opts));
    return cp;
  };
}

test('成功:退出码0且 article.md 存在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const wf = { workDir: dir, allowedTools: ['mcp__exa__web_search_exa'], timeoutMs: 1000,
    promptTemplate: (t) => `写:${t}` };
  const spawnFn = fakeSpawn((cp) => {
    fs.writeFileSync(path.join(dir, 'article.md'), '---\ntitle: T\n---\n正文');
    cp.emit('close', 0);
  });
  const r = await runClaude({ workflow: wf, input: '英伟达', config: { claudeBin: 'claude', proxy: { https: 'http://p', noProxy: 'weixin.qq.com' } }, spawnFn });
  assert.equal(r.ok, true);
  assert.ok(r.articlePath.endsWith('article.md'));
});

test('代理只进子进程 env,且带 no_proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  let seenEnv;
  const wf = { workDir: dir, allowedTools: [], timeoutMs: 1000, promptTemplate: () => 'x' };
  const spawnFn = fakeSpawn((cp, opts) => { seenEnv = opts.env; cp.emit('close', 1); });
  await runClaude({ workflow: wf, input: 'x', config: { claudeBin: 'c', proxy: { https: 'http://p', http: '', all: '', noProxy: 'weixin.qq.com' } }, spawnFn });
  assert.equal(seenEnv.https_proxy, 'http://p');
  assert.equal(seenEnv.no_proxy, 'weixin.qq.com');
});

test('无 article.md → ok:false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const wf = { workDir: dir, allowedTools: [], timeoutMs: 1000, promptTemplate: () => 'x' };
  const spawnFn = fakeSpawn((cp) => cp.emit('close', 0));
  const r = await runClaude({ workflow: wf, input: 'x', config: { claudeBin: 'c', proxy: {} }, spawnFn });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/runner.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/core/runner.js**

```js
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
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/runner.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/core/runner.js test/runner.test.js
git commit -m "feat: Claude 执行器 runner.js(代理仅进子进程)"
```

---

## Task 5: Slack 通知器(notifier.js)

**Files:**
- Create: `src/core/notifier.js`
- Test: `test/notifier.test.js`

**Interfaces:**
- Consumes: 一个 `postMessage({channel, thread_ts, text})` 客户端(生产用 bolt 的 `app.client.chat.postMessage`)
- Produces:
  - `createNotifier(postMessage) → { ack, success, failure, warn }`
  - `ack(notify, input)`、`success(notify, {title, mediaId})`、`failure(notify, {stage, error})`、`warn(notify, msg)`

- [ ] **Step 1: 写失败测试 test/notifier.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/core/notifier.js';

test('success/failure 文案带关键信息', async () => {
  const sent = [];
  const n = createNotifier(async (m) => sent.push(m));
  await n.success({ channel: 'C', ts: '1' }, { title: '英伟达财报', mediaId: 'M123' });
  await n.failure({ channel: 'C', ts: '1' }, { stage: 'publish', error: '40164 whitelist' });
  assert.match(sent[0].text, /✅/);
  assert.match(sent[0].text, /英伟达财报/);
  assert.match(sent[0].text, /M123/);
  assert.equal(sent[0].thread_ts, '1');
  assert.match(sent[1].text, /❌/);
  assert.match(sent[1].text, /publish/);
  assert.match(sent[1].text, /40164/);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/notifier.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/core/notifier.js**

```js
export function createNotifier(postMessage) {
  const send = (notify, text) => postMessage({ channel: notify.channel, thread_ts: notify.ts, text });
  return {
    ack(notify, input) { return send(notify, `收到,已入队:\n> ${String(input).slice(0, 80)}`); },
    success(notify, { title, mediaId }) { return send(notify, `✅ 草稿已发布\n标题:${title}\nMedia ID:${mediaId}`); },
    failure(notify, { stage, error }) { return send(notify, `❌ 任务失败(阶段:${stage})\n${String(error).slice(0, 500)}`); },
    warn(notify, msg) { return send(notify, `⚠️ ${msg}`); },
  };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/notifier.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/notifier.js test/notifier.test.js
git commit -m "feat: Slack 通知器 notifier.js"
```

---

## Task 6: Slack 触发器 + mock 渠道 + 装配跑通 M1

**Files:**
- Create: `src/channels/mock.js`, `src/triggers/slack.js`, `src/workflows/wechat.js`, `src/index.js`
- Test: `test/slack-trigger.test.js`

**Interfaces:**
- Consumes: queue(Task 3)、config(Task 1)
- Produces:
  - `parseSlackTask(rawText, botUserId) → string | null`(迁移自 `bot.js` 的 `任务:`/`@bot` 解析 + `cleanSlackText`)
  - `src/channels/mock.js`:`export default { id:'mock', async publish() { return { mediaId: 'MOCK', title: 'MOCK' }; } }`
  - `src/workflows/wechat.js`:导出 workflow 配置对象(promptTemplate 迁移自 `bot.js:buildPrompt`,并追加「把文章写到 article.md,frontmatter 含 title」的指令;`allowedTools` 只保留 Exa;`channel` 暂设 `mock`)
  - `src/index.js`:`start()` 组装 config→store→queue(handler 串起 runner→channel→notifier)→slack trigger;启动时 `store.markInterrupted()`

- [ ] **Step 1: 写失败测试 test/slack-trigger.test.js(纯解析函数)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackTask } from '../src/triggers/slack.js';

test('识别 "任务:" 前缀', () => {
  assert.equal(parseSlackTask('任务:写英伟达', 'B1'), '写英伟达');
  assert.equal(parseSlackTask('任务：写英伟达', 'B1'), '写英伟达');
});
test('识别 @bot 提及并清理链接', () => {
  assert.equal(parseSlackTask('<@B1> 分析 <https://x.com|X>', 'B1'), '分析 https://x.com');
});
test('非任务返回 null', () => {
  assert.equal(parseSlackTask('随便聊聊', 'B1'), null);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/slack-trigger.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/triggers/slack.js(先导出 parseSlackTask + cleanSlackText;registerSlack 装配下一步用)**

```js
import boltPkg from '@slack/bolt';
const { App } = boltPkg;

export function cleanSlackText(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

export function parseSlackTask(raw, botUserId) {
  const t = raw.trim();
  if (/^任务[:：]/.test(t)) return cleanSlackText(t.replace(/^任务[:：]\s*/, ''));
  const m = t.match(/^<@([A-Z0-9]+)>\s+([\s\S]+)/);
  if (m && (m[1] === botUserId || !botUserId)) return cleanSlackText(m[2]);
  return null;
}

export async function registerSlack({ config, enqueue, onReady }) {
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: 'warn' });
  const seen = new Set();
  const dedup = (ts) => { if (seen.has(ts)) return false; seen.add(ts); setTimeout(() => seen.delete(ts), 1800000); return true; };
  let botId = '';
  const handle = (channel, ts, raw) => {
    if (!dedup(ts)) return;
    const task = parseSlackTask(raw, botId);
    if (!task) return;
    enqueue({ workflowId: 'wechat', source: 'slack', input: task, notify: { channel, ts } });
  };
  app.message(async ({ message }) => { if (!message.bot_id && message.text) handle(message.channel, message.ts, message.text); });
  app.event('app_mention', async ({ event }) => handle(event.channel, event.ts, event.text));
  await app.start();
  botId = (await app.client.auth.test()).user_id;
  onReady?.(app);
  return app;
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/slack-trigger.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 5: 实现 mock 渠道 + wechat workflow 配置**

`src/channels/mock.js`:
```js
export default { id: 'mock', async publish() { return { mediaId: 'MOCK', title: 'MOCK' }; } };
```

`src/workflows/wechat.js`(promptTemplate 迁移自 `bot.js:281-313` 的 `buildPrompt`,追加写文件指令;发布相关指令删除):
```js
export default {
  id: 'wechat',
  triggers: ['slack'],
  workDir: process.env.WORK_DIR || '/srv/zen/wechat',
  allowedTools: ['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa'],
  channel: process.env.WECHAT_CHANNEL || 'mock',   // M2 改为 'wechat-draft'
  timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 600000),
  retries: 0,
  promptTemplate: (task) => `你是 Zen Trading 公众号分析师。完成以下写作任务。

【任务内容】
${task}

【写作规范 — 严格执行】
- 风格:严谨专业,机构分析师口吻
- 不用破折号(——),改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位(亿美元、百万美元),不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 结尾蓝色板块固定三行:
  ZEN TRADING STRATEGIES
  板块模型 · 量化策略 · 前沿解读
  本文为研究用途,不构成任何投资建议。

【调研方法 — 严格遵守】
- 用 mcp__exa__web_fetch_exa 抓取具体 URL
- 用 mcp__exa__web_search_exa 搜索
- 禁止使用浏览器/bash/curl 等其他工具,禁止调用 Skill

【产出 — 必须执行】
把完成的文章写入当前工作目录下的 article.md,文件顶部用 YAML frontmatter 给出:
---
title: 文章标题
---
正文用 Markdown。不要自行发布,发布由外部系统完成。现在开始写作。`,
};
```

- [ ] **Step 6: 实现 src/index.js 装配**

```js
import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { runClaude } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { registerSlack } from './triggers/slack.js';
import wechatWorkflow from './workflows/wechat.js';
import mockChannel from './channels/mock.js';

const WORKFLOWS = { wechat: wechatWorkflow };
const CHANNELS = { mock: mockChannel };

export async function start() {
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const interrupted = store.markInterrupted();
  if (interrupted) console.log(`[hub] 启动:${interrupted} 个残留任务标记为 interrupted`);

  let notifier;
  const handler = async (run) => {
    const wf = WORKFLOWS[run.workflowId];
    const notify = JSON.parse(store.getRun(run.id).notify_json || '{}');
    store.setStatus(run.id, 'running', { startedAt: Date.now() });
    const res = await runClaude({ workflow: wf, input: run.input, config });
    if (!res.ok) { store.setStatus(run.id, 'failed', { stage: 'generate', error: res.stderr, finishedAt: Date.now() });
      await notifier.failure(notify, { stage: 'generate', error: res.stderr }); return; }
    try {
      const channel = CHANNELS[wf.channel];
      const { mediaId, title } = await channel.publish({ articlePath: res.articlePath, config, workflow: wf, notify, notifier });
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      await notifier.success(notify, { title, mediaId });
    } catch (e) {
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      await notifier.failure(notify, { stage, error: e.message });
    }
  };

  const queue = createQueue({ store, maxConcurrency: config.maxConcurrency, handler });
  const app = await registerSlack({ config, enqueue: (t) => queue.enqueue({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...t }) });
  notifier = createNotifier((m) => app.client.chat.postMessage(m));
  console.log('⚡ Zen Content Hub 已启动');
}

if (import.meta.url === `file://${process.argv[1]}`) start();
```

> 注:`id` 生成用 `Date.now()+random`(脚本环境无需 uuid 依赖);此处在 enqueue 包装里生成,handler 里不再需要随机。

- [ ] **Step 7: 手动烟测(需真实 Slack + 一个能产出 article.md 的 claude)**

Run: `WECHAT_CHANNEL=mock node src/index.js`,在 Slack 频道发 `任务:测试一句话`。
Expected: 线程回「收到」→ 数秒后 mock 返回 → 回「✅ … Media ID:MOCK」;`runs.db` 有一条 `done`。

- [ ] **Step 8: 提交**

```bash
git add src/channels/mock.js src/triggers/slack.js src/workflows/wechat.js src/index.js test/slack-trigger.test.js
git commit -m "feat: Slack 触发器 + 装配,M1 引擎骨架跑通(mock 渠道)"
```

---

## Task 7: 微信渠道 wechat-draft.js —— renderAndPublish 发布

**Files:**
- Create: `src/channels/wechat-draft.js`, `src/lib/getInputContent.js`
- Test: `test/wechat-draft.test.js`

**Interfaces:**
- Consumes: `res.articlePath`(Task 4)、config.wechat
- Produces:
  - `src/lib/getInputContent.js`:`export async function getInputContent(inputContent, file) → { content, absoluteDirPath }`
  - `src/channels/wechat-draft.js` 默认导出 `{ id:'wechat-draft', publish({articlePath, config}), _RENDER_OPTS }`,内部调 `renderAndPublish`,返回 `{ mediaId, title }`;`_RENDER_OPTS` 导出供 parity 测试复用。
  - 失败时抛带 `.stage='render'|'publish'` 的错误。

- [ ] **Step 1: 写失败测试 test/wechat-draft.test.js(注入假 renderAndPublish + 假读文件)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannel, RENDER_OPTS } from '../src/channels/wechat-draft.js';

test('RENDER_OPTS 与 wenyan-mcp 复刻一致', () => {
  assert.deepEqual(RENDER_OPTS, { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true });
});

test('publish 调 renderAndPublish 并返回 mediaId/title', async () => {
  let calledWith;
  const channel = makeChannel({
    renderAndPublish: async (content, opts) => { calledWith = { content, opts }; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: '---\ntitle: 英伟达\n---\n正文', title: '英伟达' }),
  });
  const out = await channel.publish({ articlePath: '/x/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(out.title, '英伟达');
  assert.equal(calledWith.opts.theme, 'zen-trading');
  assert.equal(calledWith.opts.file, '/x/article.md');
});

test('renderAndPublish 抛错 → stage=publish', async () => {
  const channel = makeChannel({
    renderAndPublish: async () => { throw new Error('40164'); },
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(() => channel.publish({ articlePath: '/x/a.md', config: { wechat: {} } }), (e) => { assert.equal(e.stage, 'publish'); return true; });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/wechat-draft.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/lib/getInputContent.js**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export async function getInputContent(inputContent, file) {
  if (!inputContent && file) {
    const content = await fs.readFile(file, 'utf-8');
    return { content, absoluteDirPath: path.dirname(file) };
  }
  if (!inputContent) throw new Error('missing input-content');
  return { content: inputContent, absoluteDirPath: undefined };
}
```

- [ ] **Step 4: 实现 src/channels/wechat-draft.js**

```js
import fs from 'node:fs/promises';
import { renderAndPublish as coreRenderAndPublish } from '@wenyan-md/core/wrapper';
import { getInputContent as defaultGetInputContent } from '../lib/getInputContent.js';

// 与 wenyan-mcp dist/publish.js 完全一致的渲染参数(parity 硬要求)
export const RENDER_OPTS = { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true };

async function defaultReadArticle(articlePath) {
  const md = await fs.readFile(articlePath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const title = m && /title:\s*(.+)/.exec(m[1]) ? /title:\s*(.+)/.exec(m[1])[1].trim() : '(未命名)';
  return { markdown: md, title };
}

// 依赖注入版,便于测试
export function makeChannel({ renderAndPublish = coreRenderAndPublish, readArticle = defaultReadArticle, getInputContent = defaultGetInputContent } = {}) {
  return {
    id: 'wechat-draft',
    async publish({ articlePath, config }) {
      let title;
      try { ({ title } = await readArticle(articlePath)); }
      catch (e) { const err = new Error(`读取文章失败:${e.message}`); err.stage = 'render'; throw err; }
      // 本地模式:凭据走 env(renderAndPublish 内部读 WECHAT_APP_ID/SECRET),不传 appId
      process.env.WECHAT_APP_ID = config.wechat.appId;
      process.env.WECHAT_APP_SECRET = config.wechat.appSecret;
      try {
        const mediaId = await renderAndPublish(undefined, { ...RENDER_OPTS, file: articlePath }, getInputContent);
        return { mediaId, title };
      } catch (e) { const err = new Error(`发布失败:${e.message}`); err.stage = 'publish'; throw err; }
    },
  };
}

export default makeChannel();
```

- [ ] **Step 5: 运行,确认通过**

Run: `node --test test/wechat-draft.test.js`
Expected: PASS(3 tests)。

- [ ] **Step 6: 注册渠道到 index.js**

在 `src/index.js` 顶部加 `import wechatDraft from './channels/wechat-draft.js';`,并 `const CHANNELS = { mock: mockChannel, 'wechat-draft': wechatDraft };`。

- [ ] **Step 7: 提交**

```bash
git add src/lib/getInputContent.js src/channels/wechat-draft.js src/index.js test/wechat-draft.test.js
git commit -m "feat: 微信渠道 wechat-draft(renderAndPublish 发布,返回 media_id)"
```

---

## Task 8: 视觉一致 golden-snapshot 回归测试(验收门)

**Files:**
- Create: `test/golden/render-parity.test.js`, `test/fixtures/sample.md`, 脚本 `test/golden/capture-golden.mjs`
- Test: 上述

**Interfaces:**
- Consumes: `@wenyan-md/core` 的 `prepareRenderContext`(渲染但不发布)
- Produces: 一份 golden HTML(用当前 core 3.0.10 + RENDER_OPTS 生成),测试断言未来渲染输出与 golden 逐字符一致;core 版本漂移即红。

- [ ] **Step 1: 准备 fixture**

把现有 `~/zen-wechat-theme/sample-mu-earnings.md` 复制为 `test/fixtures/sample.md`(若过大可截取一段代表性含标题/正文/结尾板块的内容)。
Run: `cp ~/zen-wechat-theme/sample-mu-earnings.md test/fixtures/sample.md`

- [ ] **Step 2: 写 golden 捕获脚本 test/golden/capture-golden.mjs**

```js
import fs from 'node:fs/promises';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { getInputContent } from '../../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../../src/channels/wechat-draft.js';

const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file: 'test/fixtures/sample.md' }, getInputContent);
await fs.writeFile('test/golden/sample.expected.html', ctx.gzhContent.body ?? ctx.gzhContent.content ?? JSON.stringify(ctx.gzhContent));
console.log('golden 已写入 test/golden/sample.expected.html');
```

> 实现者注:`prepareRenderContext` 返回 `{ gzhContent: StyledContent }`,`StyledContent` 即 `FrontMatterResult`。首次运行前先 `console.log(Object.keys(ctx.gzhContent))` 确认承载 HTML 的字段名(body/content/html),再定稿脚本与测试取值。

- [ ] **Step 3: 生成 golden 并肉眼核对**

Run: `node test/golden/capture-golden.mjs`
Expected: 生成 `test/golden/sample.expected.html`;打开确认含 zen-trading 主题类名与结尾三行板块,与现有草稿视觉一致(可与微信后台历史草稿对比)。

- [ ] **Step 4: 写回归测试 test/golden/render-parity.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { getInputContent } from '../../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../../src/channels/wechat-draft.js';

test('渲染输出与 golden 逐字符一致(锁 core 3.0.10 + RENDER_OPTS)', async () => {
  const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file: 'test/fixtures/sample.md' }, getInputContent);
  const html = ctx.gzhContent.body ?? ctx.gzhContent.content;
  const expected = await fs.readFile('test/golden/sample.expected.html', 'utf-8');
  assert.equal(html, expected);
});
```

- [ ] **Step 5: 运行,确认通过**

Run: `node --test test/golden/render-parity.test.js`
Expected: PASS。若 FAIL,说明渲染路径/参数/版本与捕获时不一致 —— 这正是验收门要拦的。

- [ ] **Step 6: 提交**

```bash
git add test/fixtures/sample.md test/golden/
git commit -m "test: 视觉一致 golden 回归(渲染 parity 验收门)"
```

---

## Task 9: 关注名片注入(post-publish)

**Files:**
- Create: `src/lib/wechatApi.js`
- Modify: `src/channels/wechat-draft.js`(publish 成功后调名片注入)
- Test: `test/wechat-card.test.js`

**Interfaces:**
- Consumes: config.wechat、mediaId
- Produces:
  - `src/lib/wechatApi.js`:`getToken(appId, appSecret)`、`getAccountBasicInfo(token)`、`getDraft(token, mediaId)`、`updateDraft(token, mediaId, article)` —— 全部**直连**(不经代理,迁移自 `bot.js` 的 `directGet/directPost`)
  - `injectFollowCard({ config, mediaId })`:迁移自 `bot.js:324-358`,失败抛 `err.stage='card'`
  - wechat-draft.publish:发布成功后调 `injectFollowCard`;**名片失败不抛致命错**,而是通过回调 `notifier.warn` 告警并继续(见 §错误处理)

- [ ] **Step 1: 写失败测试 test/wechat-card.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowCard, locateInsertIndex } from '../src/lib/wechatApi.js';

test('buildFollowCard 含 mp-common-profile 与 appId', () => {
  const html = buildFollowCard({ appId: 'wxABC', head_img: 'h', nickname: 'Zen', user_name: 'zen_alias', signature: '专业' });
  assert.match(html, /mp-common-profile/);
  assert.match(html, /wxABC/);
  assert.match(html, /Zen/);
});

test('locateInsertIndex 定位结尾蓝色板块前', () => {
  const content = '正文<section style="background:#0E2138;border-radius:.6em;padding:1.4em">结尾</section>';
  const idx = locateInsertIndex(content);
  assert.ok(idx > 0 && idx < content.indexOf('background:#0E2138'));
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/wechat-card.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 src/lib/wechatApi.js(含纯函数 + 直连 API)**

```js
import https from 'node:https';

function directGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
function directPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body); const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

export async function getToken(appId, appSecret) {
  const d = await directGet(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`);
  if (d.errcode) throw new Error(`微信 token 失败: ${d.errmsg}`);
  return d.access_token;
}
export const getAccountBasicInfo = (t) => directGet(`https://api.weixin.qq.com/cgi-bin/account/getaccountbasicinfo?access_token=${t}`);
export const getDraft = (t, mediaId) => directPost(`https://api.weixin.qq.com/cgi-bin/draft/get?access_token=${t}`, { media_id: mediaId });
export const updateDraft = (t, mediaId, article) => directPost(`https://api.weixin.qq.com/cgi-bin/draft/update?access_token=${t}`, { media_id: mediaId, index: 0, articles: article });

export function buildFollowCard({ appId, head_img = '', nickname = '', user_name = '', signature = '' }) {
  return `<section style="text-align:center;margin:1.5em 0 1.2em;"><mp-common-profile class="js_uneditable custom_select_card mp_profile_iframe" data-pluginname="mpprofile" data-id="${appId}" data-headimg="${head_img}" data-nickname="${nickname}" data-alias="${user_name}" data-signature="${signature.replace(/"/g, '&quot;')}" data-from="0" data-is_biz_ban="0"></mp-common-profile></section>`;
}
export function locateInsertIndex(content) {
  const MARKER = 'background:#0E2138;border-radius:.6em;padding:1.4em';
  const mi = content.lastIndexOf(MARKER);
  const si = mi !== -1 ? content.lastIndexOf('<section', mi) : content.lastIndexOf('<section', content.lastIndexOf('#0E2138'));
  return si;
}

export async function injectFollowCard({ config, mediaId }) {
  try {
    const token = await getToken(config.wechat.appId, config.wechat.appSecret);
    const [acc, draft] = await Promise.all([getAccountBasicInfo(token), getDraft(token, mediaId)]);
    if (draft.errcode) throw new Error(`获取草稿失败: ${draft.errmsg}`);
    const article = draft.news_item[0];
    const card = buildFollowCard({ appId: config.wechat.appId, ...acc });
    const si = locateInsertIndex(article.content);
    const updated = si !== -1 ? article.content.slice(0, si) + card + article.content.slice(si) : article.content + card;
    const res = await updateDraft(token, mediaId, { ...article, content: updated });
    if (res.errcode && res.errcode !== 0) throw new Error(`更新草稿失败: ${res.errmsg}`);
  } catch (e) { e.stage = 'card'; throw e; }
}
```

- [ ] **Step 4: 运行纯函数测试,确认通过**

Run: `node --test test/wechat-card.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 在 wechat-draft.publish 里挂名片注入(失败仅告警)**

在 `src/channels/wechat-draft.js` 的 `publish` 成功拿到 `mediaId` 后、`return` 前:
```js
// 名片注入:失败不阻断出草稿,只告警
try { await injectFollowCard({ config, mediaId }); }
catch (e) { if (notifier && notify) await notifier.warn(notify, `名片注入失败(草稿已出):${e.message}`); }
```
并在文件顶部 `import { injectFollowCard } from '../lib/wechatApi.js';`,`publish({ articlePath, config, notify, notifier })` 增加 `notify, notifier` 形参(index.js 调用处已传 `{articlePath, config, workflow, notify, notifier}`)。为可测,`makeChannel` 增加可注入的 `injectFollowCard`。

- [ ] **Step 6: 运行全部测试**

Run: `node --test`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lib/wechatApi.js src/channels/wechat-draft.js test/wechat-card.test.js
git commit -m "feat: 关注名片注入(post-publish,失败仅告警)"
```

---

## Task 10: 封面接入 zen-push-image 生成器

**Files:**
- Create: `src/lib/cover.js`
- Modify: `src/channels/wechat-draft.js`(发布前确保 frontmatter 有 cover)
- Test: `test/cover.test.js`

**Interfaces:**
- Consumes: `~/zen-push-image/render.mjs`(Chrome 无头出 PNG,见 project_push_image 记忆)
- Produces:
  - `generateCover({ title, outDir, generatorDir, spawnFn }) → Promise<string>`(封面 PNG 绝对路径;生成器失败抛错)
  - `ensureFrontmatterCover(markdown, coverPath) → string`(若 frontmatter 无 `cover:` 则插入)

- [ ] **Step 1: 写失败测试 test/cover.test.js**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFrontmatterCover } from '../src/lib/cover.js';

test('无 cover 时插入', () => {
  const out = ensureFrontmatterCover('---\ntitle: T\n---\n正文', '/tmp/c.png');
  assert.match(out, /cover:\s*\/tmp\/c\.png/);
  assert.match(out, /title: T/);
});
test('已有 cover 时不重复插入', () => {
  const src = '---\ntitle: T\ncover: /old.png\n---\n正文';
  assert.equal(ensureFrontmatterCover(src, '/new.png'), src);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/cover.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 src/lib/cover.js**

```js
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';

export function ensureFrontmatterCover(markdown, coverPath) {
  const m = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\ncover: ${coverPath}\n---\n${markdown}`;
  if (/^\s*cover:/m.test(m[1])) return markdown;
  const fm = m[1] + `\ncover: ${coverPath}`;
  return markdown.replace(m[0], `---\n${fm}\n---`);
}

// 调 zen-push-image 生成封面;generatorDir 默认 ~/zen-push-image
export function generateCover({ title, outDir, generatorDir = `${process.env.HOME}/zen-push-image`, spawnFn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(outDir, 'cover.png');
    // render.mjs 约定:参数或 DATA 注入方式见生成器 README;此处以 CLI 参数传标题与输出路径
    const cp = spawnFn(process.execPath, [path.join(generatorDir, 'render.mjs'), '--title', title, '--out', outPath], { cwd: generatorDir, stdio: 'inherit' });
    cp.on('close', (code) => code === 0 ? resolve(outPath) : reject(Object.assign(new Error(`封面生成失败 code=${code}`), { stage: 'cover' })));
    cp.on('error', (e) => reject(Object.assign(e, { stage: 'cover' })));
  });
}
```

> 实现者注:`~/zen-push-image/render.mjs` 现有入参约定需先读其源码/README 确认(是 CLI flag 还是 `window.DATA` 注入)。若不支持 CLI flag,则在本函数内先写一个 `data.json` 再调用,与生成器现有约定对齐;保持生成器本身不改。

- [ ] **Step 4: 运行纯函数测试,确认通过**

Run: `node --test test/cover.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 在 wechat-draft.publish 里发布前生成并写入封面**

在读到 `articlePath` 后、`renderAndPublish` 前:
```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateCover, ensureFrontmatterCover } from '../lib/cover.js';
// ...
try {
  const cover = await generateCover({ title, outDir: path.dirname(articlePath) });
  const md = await fs.readFile(articlePath, 'utf-8');
  await fs.writeFile(articlePath, ensureFrontmatterCover(md, cover));
} catch (e) {
  if (notifier && notify) await notifier.warn(notify, `封面生成失败,需人工补图:${e.message}`);
  const err = new Error('缺少封面,微信草稿要求封面图'); err.stage = 'cover'; throw err;
}
```
(为可测,`makeChannel` 增加可注入 `generateCover`;默认用真实实现。)

- [ ] **Step 6: 提交**

```bash
git add src/lib/cover.js src/channels/wechat-draft.js test/cover.test.js
git commit -m "feat: 封面接入 zen-push-image 生成器"
```

---

## Task 11: 切换微信 workflow 到真实渠道 + 真实冒烟

**Files:**
- Modify: `src/workflows/wechat.js`(`channel: 'wechat-draft'`)
- Create: `deploy/smoke.md`(冒烟步骤清单)

- [ ] **Step 1: 把 workflow 默认渠道改为 wechat-draft**

`src/workflows/wechat.js` 中 `channel: process.env.WECHAT_CHANNEL || 'wechat-draft'`。

- [ ] **Step 2: 本地真实冒烟(需微信白名单已含当前出口 IP + 有 GEMINI/占位封面)**

Run: `node src/index.js`,Slack 发 `任务:用一段话测试发布链路`。
Expected: 线程收到 → ✅ 带真实 media_id;微信后台草稿箱出现该草稿,**渲染与既有主题一致**、含封面与关注名片。若报 40164 → 出口 IP 未在白名单(见 Task 12/13)。

- [ ] **Step 3: 记录冒烟清单 deploy/smoke.md**

写明:环境变量、启动命令、Slack 触发格式、成功/各类失败(generate/cover/render/publish/card)的预期回报、如何查 `runs.db`。

- [ ] **Step 4: 提交**

```bash
git add src/workflows/wechat.js deploy/smoke.md
git commit -m "feat: 微信 workflow 切真实渠道 + 冒烟清单"
```

---

## Task 12: 出站分流校验(进程边界)

**Files:**
- Create: `test/proxy-isolation.test.js`
- Modify: `src/index.js`(启动时断言主进程无代理变量,或显式清除)

**Interfaces:**
- Produces: `assertMainProcessDirect(env)` —— 若主进程 env 含 `https_proxy/http_proxy/all_proxy` 则抛错(微信调用必须直连)。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMainProcessDirect } from '../src/index.js';

test('主进程带代理变量时报错', () => {
  assert.throws(() => assertMainProcessDirect({ https_proxy: 'http://p' }), /主进程不得设置代理/);
});
test('主进程无代理变量通过', () => {
  assert.doesNotThrow(() => assertMainProcessDirect({}));
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/proxy-isolation.test.js`
Expected: FAIL。

- [ ] **Step 3: 在 src/index.js 导出并在 start() 调用**

```js
export function assertMainProcessDirect(env = process.env) {
  for (const k of ['https_proxy', 'http_proxy', 'all_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    if (env[k]) throw new Error(`主进程不得设置代理(${k});代理只允许注入 Claude 子进程。把代理配置放到 HUB_CHILD_PROXY 等专用变量。`);
  }
}
```
并在 `start()` 开头调用 `assertMainProcessDirect()`。同时把 config 里给子进程用的代理改为读专用变量(如 `CHILD_HTTPS_PROXY`),避免与主进程 `https_proxy` 冲突:更新 `loadConfig` 的 `proxy.https` 读 `env.CHILD_HTTPS_PROXY`,并同步更新 Task 1 的测试与 `.env.example`。

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: 全部 PASS(注意同步改了的 config 测试)。

- [ ] **Step 5: 提交**

```bash
git add src/index.js src/config/index.js test/proxy-isolation.test.js test/config.test.js
git commit -m "feat: 强制主进程直连,代理仅注入子进程(消灭代理污染)"
```

---

## Task 13: 部署工件(国内 VPS 常驻)

**Files:**
- Create: `deploy/.env.example`, `deploy/zen-content-hub.service`(systemd)、`deploy/README.md`、`src/lib/health.js`(Claude 认证自检)
- Test: `test/health.test.js`

**Interfaces:**
- Produces: `checkClaudeAuth({ execFn }) → Promise<{ ok, detail }>`(跑 `claude -p "ping" --output-format json` 探活,失败可告警)

- [ ] **Step 1: 写 .env.example(不含真实值)**

```
WORK_DIR=/srv/zen/wechat
DB_PATH=/srv/zen/runs.db
CLAUDE_BIN=/root/.local/bin/claude
MAX_CONCURRENCY=1
DEFAULT_TIMEOUT_MS=600000
# 代理只给 Claude 子进程用(访问 Anthropic/Exa),主进程严禁设 https_proxy
CHILD_HTTPS_PROXY=http://127.0.0.1:7897
CHILD_ALL_PROXY=socks5://127.0.0.1:7897
NO_PROXY=api.weixin.qq.com,mp.weixin.qq.com
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
NOTIFY_CHANNEL_ID=
WECHAT_APP_ID=
WECHAT_APP_SECRET=
```

- [ ] **Step 2: 写 systemd unit deploy/zen-content-hub.service**

```ini
[Unit]
Description=Zen Content Hub
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/srv/zen/app
EnvironmentFile=/srv/zen/app/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: 实现 + 测试 src/lib/health.js**

```js
export async function checkClaudeAuth({ execFn }) {
  try { const { stdout } = await execFn('claude', ['-p', 'ping', '--output-format', 'json']); return { ok: true, detail: String(stdout).slice(0, 120) }; }
  catch (e) { return { ok: false, detail: e.message }; }
}
```
`test/health.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaudeAuth } from '../src/lib/health.js';
test('exec 成功→ok', async () => { assert.equal((await checkClaudeAuth({ execFn: async () => ({ stdout: 'pong' }) })).ok, true); });
test('exec 失败→not ok', async () => { assert.equal((await checkClaudeAuth({ execFn: async () => { throw new Error('unauthorized'); } })).ok, false); });
```
Run: `node --test test/health.test.js` → PASS。

- [ ] **Step 4: 写 deploy/README.md**

覆盖:VPS 选型(国内、固定公网 IP)、把 IP 加入公众号后台白名单、装 Node 24 + Claude CLI 并完成认证(经代理)、`npm ci`、配 `.env`、`systemctl enable --now`、Claude 认证保活(定时 `checkClaudeAuth` + 失败告警到 Slack)、故障排查(40164 白名单 / token 40001 / 封面缺失)。

- [ ] **Step 5: 提交**

```bash
git add deploy/ src/lib/health.js test/health.test.js
git commit -m "chore: 国内 VPS 部署工件 + Claude 认证自检"
```

---

## Task 14: cron 触发器(为定时任务/子项目 B 预备)

**Files:**
- Create: `src/triggers/cron.js`
- Test: `test/cron.test.js`

**Interfaces:**
- Consumes: workflow 配置里的 `triggers`(形如 `'cron:0 8 * * 1'`)、`enqueue`
- Produces: `registerCron({ workflows, enqueue, scheduleFn }) → count`(为每个含 `cron:` 触发器的 workflow 注册定时,到点 enqueue;`scheduleFn` 可注入测试)

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronTriggers, registerCron } from '../src/triggers/cron.js';

test('解析 cron: 触发器', () => {
  assert.deepEqual(parseCronTriggers(['slack', 'cron:0 8 * * 1']), ['0 8 * * 1']);
});
test('为每个 cron 表达式注册一次', () => {
  const scheduled = [];
  const wf = { id: 'email', triggers: ['cron:0 8 * * 1', 'cron:0 8 * * 4'] };
  const n = registerCron({ workflows: { email: wf }, enqueue: () => {}, scheduleFn: (expr, fn) => { scheduled.push(expr); } });
  assert.equal(n, 2);
  assert.deepEqual(scheduled, ['0 8 * * 1', '0 8 * * 4']);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/cron.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 src/triggers/cron.js**

```js
import cron from 'node-cron';

export function parseCronTriggers(triggers = []) {
  return triggers.filter(t => t.startsWith('cron:')).map(t => t.slice(5));
}

export function registerCron({ workflows, enqueue, scheduleFn = cron.schedule }) {
  let count = 0;
  for (const wf of Object.values(workflows)) {
    for (const expr of parseCronTriggers(wf.triggers)) {
      scheduleFn(expr, () => enqueue({ workflowId: wf.id, source: 'cron', input: wf.cronInput ?? '(定时任务)', notify: wf.cronNotify ?? {} }));
      count++;
    }
  }
  return count;
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/cron.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 装配到 index.js**

`import { registerCron } from './triggers/cron.js';` 并在 `start()` 里 `registerCron({ workflows: WORKFLOWS, enqueue: <同 slack 的 enqueue 包装> });`(微信 workflow 无 cron 触发器,count=0,不影响)。

- [ ] **Step 6: 提交**

```bash
git add src/triggers/cron.js src/index.js test/cron.test.js
git commit -m "feat: cron 触发器(定时入队,子项目 B 预备)"
```

---

## Task 15: 重试与幂等 + 启动自愈

**Files:**
- Modify: `src/index.js`(handler 加重试;发布前查已有 media_id)、`src/core/store.js`(补 `setMediaId` 早写)
- Test: `test/retry.test.js`

**Interfaces:**
- Consumes: `workflow.retries`
- Produces: handler 在 `generate`/`cover`/`render`/`publish` 失败时按 `workflow.retries` 重跑;若某 run 已有 `media_id`(重启后重投),跳过发布直接标 done。

- [ ] **Step 1: 写失败测试(handler 重试逻辑抽成纯函数 runWithRetry)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from '../src/index.js';

test('失败后按 retries 重试', async () => {
  let n = 0;
  const r = await runWithRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, 3);
  assert.equal(r, 'ok'); assert.equal(n, 3);
});
test('超过 retries 抛最后错误', async () => {
  await assert.rejects(() => runWithRetry(async () => { throw new Error('boom'); }, 1), /boom/);
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/retry.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现 runWithRetry 并接入 handler**

在 `src/index.js`:
```js
export async function runWithRetry(fn, retries = 0) {
  let last;
  for (let i = 0; i <= retries; i++) { try { return await fn(); } catch (e) { last = e; } }
  throw last;
}
```
handler 里:发布前 `const existing = store.getRun(run.id); if (existing.media_id) { /* 已发布过,幂等跳过 */ ... }`;把 `runClaude`+发布包进 `runWithRetry(..., wf.retries)`。

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/index.js src/core/store.js test/retry.test.js
git commit -m "feat: 重试 + 发布幂等 + 启动自愈"
```

---

## Task 16: dry-run 模式 + 全量测试收尾

**Files:**
- Modify: `src/index.js`(`HUB_DRY_RUN=1` 时强制所有 workflow 走 mock 渠道)
- Create: `test/e2e-dryrun.test.js`(装配级:入队→handler→mock→落 done,不触真实网络)

- [ ] **Step 1: 实现 dry-run 开关**

`src/index.js` 选渠道时:`const channelId = process.env.HUB_DRY_RUN ? 'mock' : wf.channel;`

- [ ] **Step 2: 写端到端 dry-run 测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';

// 用 mock handler 验证 queue→store 落地 done(真实 handler 依赖 spawn,已在 runner 测试覆盖)
test('dry-run:入队后落 done', async () => {
  const store = openStore(':memory:');
  const q = createQueue({ store, maxConcurrency: 1, handler: async (run) => {
    store.setStatus(run.id, 'done', { title: 'T', mediaId: 'MOCK', finishedAt: Date.now() });
  }});
  q.enqueue({ id: 'e1', workflowId: 'wechat', source: 'slack', input: 'x', notify: {} });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(store.getRun('e1').status, 'done');
});
```

- [ ] **Step 3: 运行全量测试**

Run: `node --test`
Expected: 全部 PASS。

- [ ] **Step 4: 更新 README + 提交**

在项目 `README.md` 写:架构图、目录、`npm test`、`HUB_DRY_RUN=1 node src/index.js` 本地演练、如何加新工作流/渠道(指向子项目 B)。
```bash
git add src/index.js test/e2e-dryrun.test.js README.md
git commit -m "feat: dry-run 模式 + 端到端测试 + README"
```

---

## Self-Review(作者自查)

**Spec 覆盖**:
- §3 架构分层 → Task 1-6 目录与装配 ✓
- §4 组件(queue/runner/store/notifier/triggers/channels/net)→ Task 2-7、12、14 ✓
- §5 数据流状态机 → Task 6 handler + Task 15 幂等/自愈 ✓
- §6 微信渠道 + 视觉一致 → Task 7-10;§6 parity 硬要求 → Task 8 golden 验收门 ✓
- §7 SQLite schema → Task 2 ✓
- §8 错误处理/重试/幂等/名片不阻断/启动自愈 → Task 5、9、15 ✓
- §9 出站分流 → Task 4(子进程 env)+ Task 12(主进程强制直连)✓
- §10 部署 + §11 密钥 → Task 13 + .gitignore(已存在)✓
- §12 测试(渲染/渠道/队列/dry-run/冒烟)→ Task 8、7、3、16、11 ✓
- §14 扩展点(cron/workflow/channel)→ Task 14 + workflow/channel 注册表模式 ✓

**占位符扫描**:无 TODO/TBD;两处「实现者注」是要求实现前读源码确认具体字段(`prepareRenderContext` 承载 HTML 的字段名、`render.mjs` 入参约定)——已给出确认方法与兜底,非空泛占位。

**类型/命名一致性**:`enqueue({workflowId,source,input,notify})` 全程一致;`publish({articlePath,config,notify,notifier})` 在 index.js 调用与 channel 定义一致;`RENDER_OPTS` 在 Task 7 定义、Task 8 复用;`store.setStatus(id,status,patch)` 签名贯穿。

**已知需实现时敲定(非阻断)**:
1. `prepareRenderContext` 返回对象承载 HTML 的确切字段名(Task 8 Step 2 已给确认方法)。
2. `~/zen-push-image/render.mjs` 的入参约定(Task 10 Step 3 已给确认方法与兜底)。
3. 代理变量最终命名统一为 `CHILD_*`(Task 12 已把 config/测试/.env.example 同步纳入)。
