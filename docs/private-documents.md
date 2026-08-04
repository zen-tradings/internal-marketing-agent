# Slack 私有 Notion / Google Docs 配置

Slack 消息只需要包含标准 `https://...` 页面链接。Bot 不通过 Slack 获取 Notion 或 Google 身份，而是用部署环境中的只读凭据访问原文；分析和完整直译使用同一套权限。程序只读取，不修改 Notion、Google Docs，也不会直接发送或排期文章。

## Notion

1. 在 Notion 的 integration/connection 管理页创建内部 connection。
2. Capabilities 只开启 `Read content`，复制 installation token 到本机 `.env`：

   ```dotenv
   NOTION_API_TOKEN=...
   ```

3. 打开需要读取的私有页面，在右上角 `•••` → `Add connections` 中选择该 connection。页面中的未共享子页面不会自动获得访问权，也要按需要共享。
4. 本机只读验收：

   ```bash
   npm run check:documents -- "https://workspace.notion.site/...页面ID..."
   ```

`401` 表示 token 无效，`403` 表示缺少 `Read content` capability，`404` 通常表示页面尚未通过 `Add connections` 共享。

## Google Docs

推荐使用 OAuth refresh token，避免手动 access token 大约一小时后失效。

1. 在 Google Cloud Console 创建或选择项目，启用 Google Drive API。
2. 配置 OAuth consent screen。此 Bot 为内部工具时优先选择 `Internal`；若只能选择 `External`，把授权账号加入 test users，并注意测试状态下 refresh token 的有效期限制。
3. 创建 OAuth client，Application type 选择 `Desktop app`。
4. 将 client id 和 client secret 写入本机 `.env`：

   ```dotenv
   GOOGLE_DOCS_CLIENT_ID=...
   GOOGLE_DOCS_CLIENT_SECRET=...
   ```

5. 在本机运行：

   ```bash
   npm run auth:google-docs
   ```

   浏览器会请求 `drive.readonly`。授权完成后脚本把 `GOOGLE_DOCS_REFRESH_TOKEN` 写入本机 `.env`，不会在终端输出 token。

6. 用授权账号确实可查看的私有文档验收：

   ```bash
   npm run check:documents -- "https://docs.google.com/document/d/.../edit"
   ```

部署环境必须同时设置 `GOOGLE_DOCS_CLIENT_ID`、`GOOGLE_DOCS_CLIENT_SECRET`、`GOOGLE_DOCS_REFRESH_TOKEN`；任一缺失都会在读取时返回明确错误。`GOOGLE_DOCS_ACCESS_TOKEN` 仅用于兼容已有临时 token，在 refresh token 三项完整时不会使用。

## 部署前后验收

凭据只写入未纳入 Git 的本机 `.env` 和 DigitalOcean `/etc/zen-content-hub/zen-content-hub.env`，不要粘贴到 Slack、提交记录或任务 Prompt。

```bash
npm run check
npm run check:documents -- "<私有 Notion 链接>" "<私有 Google Docs 链接>"
```

生产部署后，在服务器执行同一个 `check:documents` 命令；脚本会自动读取 `/etc/zen-content-hub/zen-content-hub.env`，如使用其它受保护路径可通过 `ZEN_CONTENT_HUB_ENV_FILE` 指定。最后分别从允许名单内的 Slack 用户发送：

```text
请根据这份原文分析：https://...
完整直译：https://...
```

分析任务的研究 trace 应把来源标记为 `user-document`；直译 trace 的 acquisition 应包含 `notion-markdown-api` 或 `google-drive-oauth-export`。
