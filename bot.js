require('dotenv').config();
const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 直连请求（不走代理），用于国内 API（微信）
function directGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function directPost(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const WORK_DIR = process.env.WORK_DIR || '/Users/clarachen/zen-wechat-theme';
const CLAUDE_BIN = '/Users/clarachen/.local/bin/claude';
const LOG_DIR = path.join(__dirname);
const WECHAT_APPID = process.env.WECHAT_APP_ID;
const WECHAT_APPSECRET = process.env.WECHAT_APP_SECRET;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: 'warn',
});

let BOT_USER_ID = '';

// 去重：记录已处理的消息 ts，防止 message + app_mention 双触发
const processedTs = new Set();

function dedup(ts) {
  if (processedTs.has(ts)) return false;
  processedTs.add(ts);
  // 30 分钟后清理，防止 Set 无限增长
  setTimeout(() => processedTs.delete(ts), 30 * 60 * 1000);
  return true;
}

// Slack 的链接格式 <url|text> 或 <url> → 提取干净 URL
function cleanSlackText(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')  // <url|text> → url
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')            // <url> → url
    .trim();
}

async function handleTask(task, channel, ts, client) {
  if (!dedup(ts)) {
    console.log(`[ZenBot] 跳过重复消息 ts=${ts}`);
    return;
  }

  const cleanTask = cleanSlackText(task);
  console.log(`[ZenBot] 收到任务: "${cleanTask.substring(0, 100)}"`);

  try {
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `收到，正在启动写作进程...\n> ${cleanTask.substring(0, 80)}${cleanTask.length > 80 ? '...' : ''}`,
    });
  } catch (e) {
    console.error('[ZenBot] 回复确认失败:', e.message);
  }

  runClaudeTask(cleanTask, channel, ts);
}

// ── 消息监听 ──
app.message(async ({ message, client }) => {
  if (message.bot_id || !message.text) return;
  const raw = message.text.trim();
  console.log(`[message] channel=${message.channel} ts=${message.ts} text="${raw.substring(0, 60)}"`);

  let task = null;

  if (raw.startsWith('任务:') || raw.startsWith('任务：')) {
    task = raw.replace(/^任务[:：]\s*/, '').trim();
  }

  const mentionMatch = raw.match(/^<@([A-Z0-9]+)>\s+([\s\S]+)/);
  if (mentionMatch && (mentionMatch[1] === BOT_USER_ID || BOT_USER_ID === '')) {
    task = mentionMatch[2].trim();
  }

  const mentionOnly = raw.match(/^<@([A-Z0-9]+)>\s*$/);
  if (mentionOnly && (mentionOnly[1] === BOT_USER_ID || BOT_USER_ID === '')) {
    if (!dedup(message.ts)) return;
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: '请在 @ZenBot 后面加上任务内容，例如：\n@ZenBot 深度分析英伟达 Q1 FY2026 财报，财务 + 竞争对手 + 上下游',
    });
    return;
  }

  if (!task) return;
  await handleTask(task, message.channel, message.ts, client);
});

app.event('app_mention', async ({ event, client }) => {
  console.log(`[app_mention] channel=${event.channel} ts=${event.ts} text="${event.text.substring(0, 60)}"`);
  const task = event.text.replace(/<@[^>]+>/g, '').trim();

  if (!task) {
    if (!dedup(event.ts)) return;
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: '请在 @ZenBot 后面加上任务内容，例如：\n@ZenBot 深度分析英伟达 Q1 FY2026 财报，财务 + 竞争对手 + 上下游',
    });
    return;
  }

  await handleTask(task, event.channel, event.ts, client);
});

function runClaudeTask(task, notifyChannel, notifyTs) {
  const prompt = buildPrompt(task);

  // 每次任务写独立日志文件，方便排查
  const taskId = Date.now();
  const stdoutFile = path.join(LOG_DIR, `task-${taskId}.stdout.log`);
  const stderrFile = path.join(LOG_DIR, `task-${taskId}.stderr.log`);
  const stdoutStream = fs.createWriteStream(stdoutFile);
  const stderrStream = fs.createWriteStream(stderrFile);

  const TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟超时
  console.log(`[ZenBot] 启动 Claude 进程，task=${taskId}，日志: task-${taskId}.*.log`);

  const claude = spawn(CLAUDE_BIN, [
    '-p', prompt,
    '--dangerously-skip-permissions',
    '--allowedTools',
    'mcp__exa__web_search_exa,mcp__exa__web_fetch_exa,mcp__wenyan-mcp__publish_article,mcp__wenyan-mcp__list_themes',
  ], {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      HOME: '/Users/clarachen',
      https_proxy: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
      all_proxy: 'socks5://127.0.0.1:7897',
      no_proxy: 'api.weixin.qq.com,mp.weixin.qq.com',
      NO_PROXY: 'api.weixin.qq.com,mp.weixin.qq.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  claude.stdout.on('data', (d) => {
    const chunk = d.toString();
    stdout += chunk;
    stdoutStream.write(chunk);
  });

  claude.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderr += chunk;
    stderrStream.write(chunk);
    process.stderr.write(`[task-${taskId}] ${chunk}`);
  });

  // 超时保护
  const timer = setTimeout(async () => {
    console.log(`[ZenBot] task=${taskId} 超时（10分钟），强制终止`);
    claude.kill('SIGKILL');
    try {
      await app.client.chat.postMessage({
        channel: notifyChannel,
        thread_ts: notifyTs,
        text: `⏱ 写作任务超时（超过 10 分钟），已终止。\n选题：${task.substring(0, 100)}\n建议：任务涉及外部链接调研时，Claude 子进程可能卡在网络请求上。`,
      });
    } catch (e) {
      console.error('[ZenBot] 发超时通知失败:', e.message);
    }
  }, TIMEOUT_MS);

  claude.on('close', async (code) => {
    clearTimeout(timer);
    stdoutStream.end();
    stderrStream.end();
    console.log(`[ZenBot] task=${taskId} 结束，exit code=${code}`);
    console.log(`[ZenBot] stdout 日志: ${stdoutFile}`);

    if (code !== 0) {
      const errSummary = stderr.substring(0, 600) || '（无 stderr 输出，查看日志文件）';
      try {
        await app.client.chat.postMessage({
          channel: notifyChannel,
          thread_ts: notifyTs,
          text: `❌ 写作任务失败（exit code ${code}）\n选题：${task.substring(0, 100)}\n日志文件：\`task-${taskId}.stderr.log\`\n\`\`\`${errSummary}\`\`\``,
        });
      } catch (e) {
        console.error('[ZenBot] 发失败通知出错:', e.message);
      }
      return;
    }

    const mediaIdMatch = stdout.match(/MEDIA_ID:\s*([^\s\n]+)/);
    const titleMatch = stdout.match(/TITLE:\s*([^\n]+)/);
    const mediaId = mediaIdMatch ? mediaIdMatch[1].trim() : null;
    const title = titleMatch ? titleMatch[1].trim() : '（未提取到）';

    console.log(`[ZenBot] 发布成功，media_id=${mediaId}`);

    if (!mediaId) {
      // Claude 完成但未成功发布（如白名单拦截）
      try {
        await app.client.chat.postMessage({
          channel: notifyChannel,
          thread_ts: notifyTs,
          text: `⚠️ 写作完成但草稿未发布\n标题：${title}\n选题：${task.substring(0, 80)}\n原因：Claude 未返回 media_id，可能是 IP 白名单或其他发布错误，查看 \`task-${taskId}.stdout.log\` 了解详情。`,
        });
      } catch (e) {
        console.error('[ZenBot] 发警告通知失败:', e.message);
      }
      return;
    }

    // 注入公众号名片
    try {
      await injectFollowCard(mediaId);
    } catch (e) {
      console.error('[ZenBot] 名片注入失败:', e.message);
    }

    try {
      await app.client.chat.postMessage({
        channel: notifyChannel,
        thread_ts: notifyTs,
        text: `✅ 草稿已发布（含关注名片）\n标题：${title}\n选题：${task.substring(0, 80)}\nMedia ID：${mediaId}`,
      });
    } catch (e) {
      console.error('[ZenBot] 发成功通知失败:', e.message);
    }
  });

  claude.on('error', async (err) => {
    console.error(`[ZenBot] 启动 Claude 失败: ${err.message}`);
    try {
      await app.client.chat.postMessage({
        channel: notifyChannel,
        thread_ts: notifyTs,
        text: `❌ 无法启动 Claude 进程：${err.message}`,
      });
    } catch (e) {
      console.error('[ZenBot] 发错误通知失败:', e.message);
    }
  });
}

function buildPrompt(task) {
  return `你是 Zen Trading 公众号分析师。完成以下写作任务并发布到微信草稿箱。

【任务内容】
${task}

【写作规范 — 严格执行】
- 主题：zen-trading
- 风格：严谨专业，机构分析师口吻
- 不用破折号（——），改用逗号或冒号
- 括号内容极度克制，非必要不加
- 金额用中文单位（亿美元、百万美元），不出现美元符号 $
- 口径说明板块每个控制在 1-2 句
- 结尾蓝色板块固定三行格式：
  ZEN TRADING STRATEGIES
  板块模型 · 量化策略 · 前沿解读
  本文为研究用途，不构成任何投资建议。

【调研外部链接的方法 — 严格遵守】
- 用 mcp__exa__web_fetch_exa 抓取具体 URL 的内容
- 用 mcp__exa__web_search_exa 搜索相关信息
- 禁止使用 CDP、浏览器、bash、curl 等其他任何工具
- 禁止调用 Skill，直接用 Exa MCP 工具

【完成后必须执行】
调用 mcp__wenyan-mcp__publish_article 工具（theme_id="zen-trading"）将文章发布到微信草稿箱。

发布成功后，在你的最终回复的最后两行输出以下格式（必须精确匹配）：
TITLE: [文章标题]
MEDIA_ID: [返回的media_id]

现在开始写作。`;
}

// ── 微信公众号名片注入 ──
async function getWechatToken() {
  const data = await directGet(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_APPSECRET}`
  );
  if (data.errcode) throw new Error(`获取微信 token 失败: ${data.errmsg}`);
  return data.access_token;
}

async function injectFollowCard(mediaId) {
  const token = await getWechatToken();

  const [accountRes, draftRes] = await Promise.all([
    directGet(`https://api.weixin.qq.com/cgi-bin/account/getaccountbasicinfo?access_token=${token}`),
    directPost(`https://api.weixin.qq.com/cgi-bin/draft/get?access_token=${token}`, { media_id: mediaId }),
  ]);

  if (draftRes.errcode) throw new Error(`获取草稿失败: ${draftRes.errmsg}`);

  const article = draftRes.news_item[0];
  const content = article.content;

  const followCard = `<section style="text-align:center;margin:1.5em 0 1.2em;"><mp-common-profile class="js_uneditable custom_select_card mp_profile_iframe" data-pluginname="mpprofile" data-id="${WECHAT_APPID}" data-headimg="${accountRes.head_img || ''}" data-nickname="${accountRes.nickname || ''}" data-alias="${accountRes.user_name || ''}" data-signature="${(accountRes.signature || '').replace(/"/g, '&quot;')}" data-from="0" data-is_biz_ban="0"></mp-common-profile></section>`;

  const BLUE_MARKER = 'background:#0E2138;border-radius:.6em;padding:1.4em';
  const markerIdx = content.lastIndexOf(BLUE_MARKER);
  const sectionIdx = markerIdx !== -1
    ? content.lastIndexOf('<section', markerIdx)
    : content.lastIndexOf('<section', content.lastIndexOf('#0E2138'));

  const updatedContent = sectionIdx !== -1
    ? content.slice(0, sectionIdx) + followCard + content.slice(sectionIdx)
    : content + followCard;

  const updateRes = await directPost(
    `https://api.weixin.qq.com/cgi-bin/draft/update?access_token=${token}`,
    { media_id: mediaId, index: 0, articles: { ...article, content: updatedContent } }
  );

  if (updateRes.errcode && updateRes.errcode !== 0) {
    throw new Error(`更新草稿失败: ${updateRes.errmsg}`);
  }
  console.log(`[ZenBot] 名片注入完成，media_id=${mediaId}`);
}

(async () => {
  // 启动重试：等代理/网络就绪（最多等 5 分钟，每 10 秒一次）
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await app.start();
      const authRes = await app.client.auth.test();
      BOT_USER_ID = authRes.user_id;
      console.log(`\n⚡ ZenBot 已启动（Socket Mode）`);
      console.log(`   Bot User ID: ${BOT_USER_ID}`);
      console.log(`   工作目录: ${WORK_DIR}`);
      console.log(`   任务日志目录: ${LOG_DIR}`);
      console.log('');
      break;
    } catch (e) {
      console.error(`[ZenBot] 启动失败（第 ${attempt} 次）: ${e.message}，10 秒后重试...`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
})();
