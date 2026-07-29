import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadDirectUserSources } from '../src/core/user-sources.js';

const envPath = process.env.ZEN_CONTENT_HUB_ENV_FILE
  || (fsSync.existsSync('/etc/zen-content-hub/zen-content-hub.env')
    ? '/etc/zen-content-hub/zen-content-hub.env'
    : '.env');
dotenv.config({ path: envPath });
const urls = process.argv.slice(2).map((value) => String(value || '').trim()).filter(Boolean);
if (!urls.length) {
  console.error('用法：npm run check:documents -- "<Notion 或 Google Docs 私有链接>" [...]');
  process.exit(1);
}

const config = {
  translation: {
    browserEnabled: process.env.TRANSLATION_BROWSER_ENABLED !== 'false',
    browserExecutablePath: process.env.TRANSLATION_BROWSER_EXECUTABLE || '',
    notionApiToken: process.env.NOTION_API_TOKEN || '',
    datalabApiKey: process.env.DATALAB_API_KEY || '',
    datalabBaseUrl: process.env.DATALAB_API_BASE_URL || 'https://www.datalab.to/api/v1',
  },
  documents: {
    googleDocsAccessToken: process.env.GOOGLE_DOCS_ACCESS_TOKEN || '',
    googleDocsClientId: process.env.GOOGLE_DOCS_CLIENT_ID || '',
    googleDocsClientSecret: process.env.GOOGLE_DOCS_CLIENT_SECRET || '',
    googleDocsRefreshToken: process.env.GOOGLE_DOCS_REFRESH_TOKEN || '',
    githubToken: process.env.GITHUB_TOKEN || '',
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
  },
};
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-private-doc-check-'));
try {
  const result = await loadDirectUserSources({
    userUrls: urls,
    workDir,
    config,
  });
  for (const source of result.sources) {
    console.log(`OK ${source.extractor} ${source.title || source.url} (${source.text.length} chars)`);
  }
  for (const error of result.errors) {
    console.error(`FAIL ${error.kind || 'document'} ${error.url}: ${error.error}`);
  }
  if (result.sources.length !== urls.length || result.errors.length) process.exitCode = 1;
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
