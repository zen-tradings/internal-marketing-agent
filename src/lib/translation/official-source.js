import { JSDOM } from 'jsdom';
import { safeFetchResource } from '../safe-fetch.js';

// Explicitly registered publisher API. Never infer API endpoints for arbitrary
// sites or accept a search excerpt as the user's original article.
export function officialArticleApi(sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || !['www.hudsonrivertrading.com', 'hudsonrivertrading.com'].includes(url.hostname)) return;
  const match = /^\/hrtbeat\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (!match) return;
  const api = new URL('https://www.hudsonrivertrading.com/wp-json/wp/v2/posts');
  api.searchParams.set('slug', match[1]);
  return { url: api.href, slug: match[1] };
}

export function officialArticleImageMirror(sourceUrl, imageUrl) {
  if (!officialArticleApi(sourceUrl)) return;
  const image = new URL(imageUrl);
  if (image.protocol !== 'https:' || image.port || image.username || image.password || image.search
    || !['www.hudsonrivertrading.com', 'hudsonrivertrading.com'].includes(image.hostname)
    || !/^\/wp-content\/uploads\/\d{4}\/\d{2}\/[a-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/i.test(image.pathname)) return;
  // Photon keys its cache by the exact public origin URL. No resize, crop or
  // format parameters: preserve the original chart, never substitute a search image.
  return `https://i0.wp.com/${image.hostname}${image.pathname}?ssl=1`;
}

export async function fetchOfficialArticleHtml({ sourceUrl, descriptor, fetchFn, fetchWithRetry, limits, dnsLookup }) {
  const fetched = await safeFetchResource({
    url: descriptor.url, fetchFn, fetchWithRetry, limits, dnsLookup,
    accept: 'application/json',
  });
  const expected = new URL(descriptor.url);
  const final = new URL(fetched.finalUrl);
  if (final.origin !== expected.origin || final.pathname !== expected.pathname
    || final.searchParams.get('slug') !== descriptor.slug) {
    throw new Error('官方原文 API 重定向到非登记入口');
  }
  const posts = JSON.parse(fetched.buffer.toString('utf8'));
  if (!Array.isArray(posts) || posts.length !== 1) throw new Error('官方原文 API 未返回唯一文章');
  const post = posts[0];
  const canonical = new URL(post.link);
  const requested = new URL(sourceUrl);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.port
    || !['www.hudsonrivertrading.com', 'hudsonrivertrading.com'].includes(canonical.hostname)
    || canonical.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '')
    || canonical.search || post.slug !== descriptor.slug || post.status !== 'publish' || post.type !== 'post'
    || post.content?.protected || !post.content?.rendered?.trim() || !post.title?.rendered?.trim()) {
    throw new Error('官方原文 API 的文章身份或完整正文无法核验');
  }
  const dom = new JSDOM('<!doctype html><html><head></head><body><article></article></body></html>');
  const document = dom.window.document;
  const title = document.createElement('title');
  title.innerHTML = post.title.rendered;
  document.head.append(title);
  // HRT's WP/Yoast author identifies the CMS account, which can differ from the
  // article's visible byline. Do not misattribute the article to its uploader.
  for (const [name, content] of [['date', post.date_gmt ? `${post.date_gmt}Z` : post.date]]) {
    if (!content) continue;
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  document.querySelector('article').innerHTML = post.content.rendered;
  return { html: dom.serialize(), documentUrl: canonical.href, extractor: 'hrt-wordpress-api' };
}
