# Customer.io newsletter 发布工作流

## 当前配置与历史记录

本节中的发送结果和人数是当时的运维记录，不是 Customer.io 的实时状态。每次创建或扩容前都必须运行 `npm run check:customerio`，并以 Customer.io Review 页显示的人数为最终依据。

- 命名格式：`Zen Research from Zen Trading · Vol. N`
- Slack 入口：私聊自然语言或频道 `@Bot`；`邮件：<本期主题>`、`email: <topic>` 继续兼容。
- 常规 `email:` 工作流只在 Customer.io 创建草稿，不会自动发送或排期；`opening-digest` 是独立的受控发送/排期例外。
- Customer.io 内部测试分组：`Newsletter · Internal Beta`，segment ID `17`。
- Customer.io Pilot 分组：`Newsletter · Pilot`，segment ID `18`。这是第二批扩容名单，当前为空，加入人员前不能创建 Pilot 草稿。
- 全量候选分组：`Valid Email Address`，segment ID `6`。切换前仍要在 Review 页核对订阅偏好与预计人数。
- 新生成草稿的主题和邮件内品牌统一为 `Zen Research from Zen Trading · Vol. N`；不自动改写历史草稿或已发送邮件。
- 仓库生成的 Customer.io 模板页脚实体地址固定为 `700 Leahy St, Redwood City, CA 94061`；环境变量、Prompt 和单次任务都不能覆盖。历史草稿和已发送邮件不会被回溯改写。
- `Vol. 1` 已向内部 segment `17` 发送体验版：修正版 newsletter ID `5` 的 3 条消息全部 delivered，failed/suppressed 均为 0。

### Opening Digest 当前实现

生产环境在美东交易日 10:15 生成 Opening Digest；若完成时距 10:30 仍超过 Customer.io 要求的 5 分钟最小提前量，则排期到 10:30，否则立即发送。这里的“opening”是开盘后摘要，不是 9:30 开盘铃时点。

内容检索使用上一交易日 16:00 ET 到当前时刻的专用美股开盘窗口，分别覆盖市场新闻、宏观/利率和公司催化剂。两个标准区块、3-5 条 catalyst、链接去重、检索匹配、发布日期与当前窗口都是写作和软审计要求；偏差只写入 `research-trace.json`，不阻止发送。零研究结果或正文生成失败时发送带中性提示的数据版。仅当事实问题同时具备高置信度、影响核心结论和具体来源证据，且两轮局部修复仍失败时，才 fail closed。

生产环境在 DigitalOcean 的 Chrome 会从 OIC/iVolatility iframe 提取 20 行、8 个字段，截图仅用于同会话前后数据一致性校验并立即丢弃；邮件正文渲染为移动端可读的 HTML 表格。OIC 授权、会话、浏览器、页面或数据校验失败时整个期权区块省略，诊断只记录到 trace。市场快照始终渲染固定 9 格，不可用项显示 `—`；2Y UST 使用美国财政部最新可用的 daily par yield。已取消无消费者的 EOD 缓存任务。受众名称成功读取且不是 `test2` 时仍硬停；预检失败或人数为 0 只记 trace，最终以 Customer.io 请求结果为准。

封面固定以 `assets/zen-opening-digest-background.png` 为唯一底图；源图尺寸、SHA-256 和输出 1240×620 尺寸在渲染器内仍严格校验。Chrome 只在底图中部留白区叠加 `OPENING DIGEST` 和当日美东日期。底图、浏览器渲染或 Customer.io 上传失败时，渠道改为发送无封面版并把原因写入 trace。

API 创建的邮件会被 Customer.io workspace layout 包裹。Opening Digest 正文不自行加入退订链接，渲染前会本地删除模型意外输出的 `{% unsubscribe_url %}`。发送链路不再调用 Customer.io `/contents` 读回接口，workspace layout 唯一负责法定退订链接。

所有可继续发送的降级只写入 `research-trace.json`，不发 Slack warning。只有硬门禁或客观执行失败使用现有 Slack failure 通知。
- newsletter ID `1` 的首次尝试因退订链接误用变量语法，在 Customer.io 渲染阶段 3 条全部失败；没有错误邮件离开平台。保留该记录用于审计，不复用或扩容。
- 内部分组目前只包含 Customer.io 中已经存在的 3 位内部人员。扩充体验名单时，先把人员加入该手工 segment，再回到 Review 页核对人数。

Customer.io 的 App API 不能改写由 Design Studio 创建的邮件正文，因此保留两条发布路径：

1. 现有 `Vol. 1` 使用 Customer.io Design Studio 模板，人工替换内容并试发。
2. Slack `email:` 工作流固定使用仓库内 `zen-customerio/zen-research@3` 邮件 HTML 模板创建新的 Customer.io 草稿，适合后续稳定自动化。

两条路径都必须经过 Customer.io Review 页，任何发送或排期都由人工确认。

Bot 自动化路径不接受单次任务或工作流覆盖模板。真实渠道会在调用 Customer.io 前核对中央登记的模板 ID、锁定状态和最终 HTML 模板标识；任一不匹配都会拒绝创建草稿。后续改版必须升级模板版本并更新离线渲染测试。

## 每一期的发布步骤

1. 设置 `NEWSLETTER_EDITION=Vol. N`。
2. 在 Slack 私聊自然描述“给订阅者写一期 Newsletter，主题、核心判断、必须覆盖的链接……”，或在公共频道 `@Bot`；无需记忆固定前缀。
3. Bot 完成调研和写作，在 Customer.io 创建 newsletter 草稿。
4. 编辑复核：标题、主题、preheader、链接、数字、来源、移动端、暗色模式、退订链接和公司地址。
5. 内部阶段保持 `NEWSLETTER_AUDIENCE_STAGE=internal`，只向手工加入 segment `17` 的人员发送。
6. 收集反馈并修订；不要在同一个草稿里直接把内部 segment 改成全量 segment 后立即发送。
7. 复制已通过审核的版本，把人员逐步加入 segment `18`，再设置 `NEWSLETTER_AUDIENCE_STAGE=pilot`；每一批都先在 Review 页确认人数、订阅偏好和排期。
8. 最终全量阶段才设置 `NEWSLETTER_AUDIENCE_STAGE=full` 和 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`，使用 segment `6`，并保留 Customer.io 的订阅过滤。

## 三阶段受众门禁

| Stage | Customer.io segment | 文档记录人数（非实时） | 默认人数上限 | 额外门禁 |
|---|---|---:|---:|---|
| `internal` | `Newsletter · Internal Beta`（17） | 3 | 10 | 默认阶段 |
| `pilot` | `Newsletter · Pilot`（18） | 0 | 50 | 空名单拒绝创建草稿 |
| `full` | `Valid Email Address`（6） | 120 | 不设默认上限 | 必须设置 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true` |

Bot 在创建草稿前调用 Customer.io 读取实时 segment 人数。受众为空、人数超过该阶段上限、segment 不存在或全量阶段未解锁时，都会在创建草稿前失败。这个预检只保护 Bot 创建的新草稿；Customer.io 网页中的发送动作仍需人工在 Review 页确认。

切换阶段或改动名单后先运行只读检查：

```bash
npm run check:customerio
```

它会显示三个 segment 的实时人数、当前阶段、同版号草稿/已发送记录的 delivered/failed 状态和所有缺失门禁，不会创建、排期或发送邮件。

## 扩容门槛

每一批至少检查以下信号后再扩大：

- 硬退信、垃圾邮件投诉和退订是否异常上升。
- 主要邮箱服务商是否出现集中退信或投递延迟。
- 打开、点击和关键链接是否符合预期，链接是否存在 404 或错误跳转。
- 内部反馈中的排版、术语、事实和移动端问题是否已经关闭。
- Customer.io Review 页显示的预计人数是否与本批目标一致。

出现异常时停止扩容，保留当前 segment 和草稿，不要通过 `Everyone in workspace` 绕过分组门槛。

## 必填配置

```dotenv
CUSTOMERIO_APP_API_KEY=
NEWSLETTER_AUDIENCE_STAGE=internal
CUSTOMERIO_INTERNAL_SEGMENT_ID=17
CUSTOMERIO_PILOT_SEGMENT_ID=18
CUSTOMERIO_FULL_SEGMENT_ID=6
CUSTOMERIO_INTERNAL_MAX_RECIPIENTS=10
CUSTOMERIO_PILOT_MAX_RECIPIENTS=50
# 可选：full 阶段的额外人数上限；留空时不额外限制。
CUSTOMERIO_FULL_MAX_RECIPIENTS=
CUSTOMERIO_ALLOW_FULL_AUDIENCE=false
CUSTOMERIO_NEWSLETTER_FROM="Zen Trading <support@zentradings.com>"
CUSTOMERIO_NEWSLETTER_FEEDBACK_URL=
CUSTOMERIO_NEWSLETTER_HEADER_IMAGE_URL=
CUSTOMERIO_NEWSLETTER_CONTACT_EMAIL=
NEWSLETTER_EDITION="Vol. 1"
```

`CUSTOMERIO_NEWSLETTER_HEADER_IMAGE_URL` 是开头品牌图的公开图片 URL(用 Customer.io 图床里的 https 地址,不要用仓库本地图);留空则不渲染顶部图。`CUSTOMERIO_NEWSLETTER_CONTACT_EMAIL` 是页脚展示的联系邮件，也是没有公开反馈页时满意度按钮的 `mailto:` 目标。配置 `CUSTOMERIO_NEWSLETTER_FEEDBACK_URL` 后，满意/不满意按钮会改为带 `rating=positive|negative` 和 `edition` 的网页链接。仓库模板保留法律强制的 `{% unsubscribe_url %}`，公司实体地址固定为 `700 Leahy St, Redwood City, CA 94061`。发送前可用 `npm run preview:newsletter` 生成本地 HTML 预览(不调用外部 API、不创建草稿)核对排版。

所有新建 Newsletter 的可见发件人固定为 `Zen Trading <support@zentradings.com>`；发布渠道会在创建草稿前校验邮箱，防止环境变量漂移到其他发件地址。

核心自动化使用 App API，只创建 Newsletter 草稿。Customer.io MCP 可供人工管理草稿使用，但不进入 Bot 的核心链，也不为 Bot 配置发送所需的 `write:live` 权限。

内容门禁按类型执行：研究型 Newsletter 强制官方/一手来源、紧邻引用和事实审查；欢迎、首封问候、需求收集、产品或 Agent 介绍、通知公告等关系型邮件跳过外部研究与引用门禁，只使用任务中给出的材料。明确要求官方数据或市场分析时仍按研究型处理。

`CUSTOMERIO_APP_API_KEY` 使用 workspace 级 App API key；不要提交到 Git。旧的 `CUSTOMERIO_NEWSLETTER_SEGMENT_ID` 只作为 `internal` 的兼容回退，新配置应使用三个明确的阶段 segment。实体地址已进入固定模板，不再使用 `CUSTOMERIO_COMPANY_ADDRESS`。带空格的版号值必须加引号，否则 shell 读取 `.env` 时会把 `1` 当成命令。

Customer.io 的退订和偏好中心是 Liquid **tag**，不是变量：必须分别写成 `{% unsubscribe_url %}` 和 `{% manage_subscription_preferences_url %}`。不要改成双花括号变量语法。
