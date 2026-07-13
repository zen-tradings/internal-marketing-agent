# Customer.io newsletter 发布工作流

## 当前配置

- 命名格式：`Zen Trading Newsletter · Vol. N`
- Slack 入口：`邮件：<本期主题>` 或 `email: <topic>`
- 本地工作流只在 Customer.io 创建草稿，不会自动发送或排期。
- Customer.io 内部测试分组：`Newsletter · Internal Beta`，segment ID `17`。
- Customer.io Pilot 分组：`Newsletter · Pilot`，segment ID `18`。这是第二批扩容名单，当前为空，加入人员前不能创建 Pilot 草稿。
- 全量候选分组：`Valid Email Address`，segment ID `6`。切换前仍要在 Review 页核对订阅偏好与预计人数。
- 现有 Design Studio 内容已用于 `Vol. 1`，主题和邮件内标题均为 `Zen Trading Newsletter · Vol. 1`。
- Design Studio 模板已发布版号标题、内部体验内容、官网链接、反馈入口、退订链接和 Customer.io 账户中登记的公司地址；原始 demo 文案、`[Address]` 与错误链接已移除。
- `Vol. 1` 已向内部 segment `17` 发送体验版：修正版 newsletter ID `5` 的 3 条消息全部 delivered，failed/suppressed 均为 0。
- newsletter ID `1` 的首次尝试因退订链接误用变量语法，在 Customer.io 渲染阶段 3 条全部失败；没有错误邮件离开平台。保留该记录用于审计，不复用或扩容。
- 内部分组目前只包含 Customer.io 中已经存在的 3 位内部人员。扩充体验名单时，先把人员加入该手工 segment，再回到 Review 页核对人数。

Customer.io 的 App API 不能改写由 Design Studio 创建的邮件正文，因此保留两条发布路径：

1. 现有 `Vol. 1` 使用 Customer.io Design Studio 模板，人工替换内容并试发。
2. Slack `email:` 工作流使用仓库内的邮件 HTML 模板创建新的 Customer.io 草稿，适合后续稳定自动化。

两条路径都必须经过 Customer.io Review 页，任何发送或排期都由人工确认。

## 每一期的发布步骤

1. 设置 `NEWSLETTER_EDITION=Vol. N`。
2. 在 Slack 提交 `邮件：<主题、核心判断、必须覆盖的链接>`。
3. Bot 完成调研和写作，在 Customer.io 创建 newsletter 草稿。
4. 编辑复核：标题、主题、preheader、链接、数字、来源、移动端、暗色模式、退订链接和公司地址。
5. 内部阶段保持 `NEWSLETTER_AUDIENCE_STAGE=internal`，只向手工加入 segment `17` 的人员发送。
6. 收集反馈并修订；不要在同一个草稿里直接把内部 segment 改成全量 segment 后立即发送。
7. 复制已通过审核的版本，把人员逐步加入 segment `18`，再设置 `NEWSLETTER_AUDIENCE_STAGE=pilot`；每一批都先在 Review 页确认人数、订阅偏好和排期。
8. 最终全量阶段才设置 `NEWSLETTER_AUDIENCE_STAGE=full` 和 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`，使用 segment `6`，并保留 Customer.io 的订阅过滤。

## 三阶段受众门禁

| Stage | Customer.io segment | 当前人数 | 默认人数上限 | 额外门禁 |
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
CUSTOMERIO_ALLOW_FULL_AUDIENCE=false
CUSTOMERIO_NEWSLETTER_FROM=
CUSTOMERIO_COMPANY_ADDRESS=
CUSTOMERIO_NEWSLETTER_FEEDBACK_URL=
NEWSLETTER_EDITION="Vol. 1"
```

`CUSTOMERIO_APP_API_KEY` 使用 workspace 级 App API key；不要提交到 Git。旧的 `CUSTOMERIO_NEWSLETTER_SEGMENT_ID` 只作为 `internal` 的兼容回退，新配置应使用三个明确的阶段 segment。`CUSTOMERIO_COMPANY_ADDRESS` 在创建草稿前强制要求，避免生成缺少实体地址的可发送邮件。带空格的版号值必须加引号，否则 shell 读取 `.env` 时会把 `1` 当成命令。

Customer.io 的退订和偏好中心是 Liquid **tag**，不是变量：必须分别写成 `{% unsubscribe_url %}` 和 `{% manage_subscription_preferences_url %}`。不要改成双花括号变量语法。
