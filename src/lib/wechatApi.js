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
