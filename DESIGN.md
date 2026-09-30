# AgentWallet 设计文档

> 状态：v0.2 已实现（2026-09-30）：MCP 服务 + Web 管理端

## 1. 概述

AgentWallet 为角色扮演中的角色（"家机"，即家里的陪伴机器人）以及玩家提供**虚拟钱包**。钱包只在剧情中有意义，不对接任何真实支付。

示例：剧情推进到"家机 A 领了工资 8000 元"，大模型通过 MCP 调用记账工具，家机 A 的余额增加 8000 元。

## 2. 术语

| 术语 | 含义 |
|---|---|
| 用户（user） | 使用服务的真人，是数据隔离的边界 |
| 账户（account） | 有余额的钱包，分 `player`（玩家，每个用户 1 个）和 `character`（角色，每个用户 N 个） |
| 外部对象（external） | 不在系统中的交易对方，例如"XX公司"、"XX兼职"、"便利店"，只有名称，没有余额 |
| 交易（transaction） | 一笔资金流动：从 `from` 流向 `to`，两端各是账户或外部对象 |

## 3. 首版范围

**包含**
- 多用户，每个用户有 1 个玩家账户和多个角色账户
- 收入、支出、同一用户下账户之间的转账（统一用"交易"表达）
- 外部对象用自由文本记录
- 可透支，每个账户可单独设置透支额度，默认 0
- 创建账户时可指定初始余额
- 撤销交易（作废）
- 通过 MCP（Streamable HTTP）远程接入，按用户 API Key 鉴权

**不包含（后续版本）**
- 原生 App
- 余额走势图、导出 CSV
- 多币种
- 资产、物品、背包
- 外部对象归并与统计
- 跨用户转账
- OAuth 鉴权

## 4. 架构

```
┌──────────────────────┐
│ 自研聊天程序 / Claude 等 │  MCP 客户端（多用户、远程）
└──────────┬───────────┘
           │ Streamable HTTP + Bearer API Key
┌──────────▼───────────┐
│ AgentWallet 服务       │
│  ├ /mcp   MCP 端点     │
│  ├ /healthz            │
│  ├ auth   鉴权与用户隔离  │
│  └ core   记账核心逻辑   │
└──────────┬───────────┘
           │
        SQLite（经 Drizzle ORM，可切换 Postgres）
```

- 所有业务规则都在 `core` 层，MCP 层只做参数解析和结果格式化。以后的 Web 管理端复用 `core`。
- MCP 使用**无状态**模式，每个请求独立鉴权，便于水平扩展。

## 5. 数据模型

金额一律以**整数"分"**存储。时间统一以 UTC 存储，对外按 `Asia/Shanghai` 展示。

```
users
  id              text pk
  name            text
  created_at      integer (epoch ms, UTC)

api_keys
  id              text pk
  user_id         text fk -> users
  key_hash        text unique        -- SHA-256，不存明文
  label           text
  created_at      integer
  revoked_at      integer null

accounts
  id              text pk
  user_id         text fk -> users
  kind            text               -- 'player' | 'character'
  name            text               -- 同一用户下唯一，供模型引用
  overdraft_limit integer default 0  -- 最多可欠多少（分，>= 0）
  created_at      integer
  archived_at     integer null       -- 归档，不物理删除
  UNIQUE(user_id, name)

transactions
  id              text pk
  user_id         text fk -> users
  type            text               -- 'opening' | 'normal' | 'adjustment'
  from_account_id text null fk -> accounts
  from_external   text null
  to_account_id   text null fk -> accounts
  to_external     text null
  amount          integer            -- 分，> 0
  reason          text
  message_id      text null          -- 可选：宿主提供的消息 ID，便于重新生成时撤账
  idempotency_key text null
  status          text               -- 'active' | 'voided'
  void_reason     text null
  voided_at       integer null
  created_at      integer
  UNIQUE(user_id, idempotency_key)
```

**余额** = 该账户作为 `to` 的有效交易金额之和 − 作为 `from` 的有效交易金额之和（只计 `status = 'active'`）。

## 6. 业务规则

1. **交易两端**：`from` 和 `to` 各是"账户"或"外部对象"二选一，并且至少有一端是账户；两端不能是同一个账户。
2. **用户隔离**：交易涉及的账户必须都属于当前用户。
3. **扣款授权**：同一用户下的任何账户都可以作为付款方，不限定参与者。剧情上的对错由用户自己把控，出错了可以撤销。
4. **透支检查**：付款方是账户时，要求 `余额 − 金额 >= −overdraft_limit`，否则拒绝。拒绝时的错误信息里带上当前余额和可用额度，方便模型据此调整剧情。检查和写入在同一个数据库事务里完成。
5. **开户**：创建账户时如果指定了非 0 的初始余额，就生成一笔 `type = 'opening'` 的交易，对方是外部对象"初始余额"。初始余额不能低于 `−overdraft_limit`。
6. **撤销**：交易只能标记为 `voided`，不物理删除。撤销时**不做**透支检查，因为撤销属于纠错。
7. **幂等**：带 `idempotency_key` 的重复请求，直接返回第一次的结果，不重复记账。
8. **金额输入**：以"元"为单位，必须大于 0，最多两位小数。按字符串解析成"分"，避免浮点误差。
9. **账户名解析**：工具参数里的账户名按当前用户下未归档的账户精确匹配；匹配不到就报错，并列出可用的账户名。

## 7. MCP 工具

所有工具都在当前 API Key 对应的用户范围内执行。账户用 `name` 引用，模型更容易使用。

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_accounts` | — | 列出账户及余额 |
| `get_balance` | `account` | 查询单个账户的余额、透支额度、可用额度 |
| `create_account` | `name`, `initial_balance?`, `overdraft_limit?` | 创建角色账户 |
| `update_account` | `account`, `new_name?`, `overdraft_limit?` | 改名或调整透支额度 |
| `archive_account` | `account` | 归档角色账户（玩家账户不能归档） |
| `record_transaction` | `from`, `to`, `amount`, `reason`, `message_id?`, `idempotency_key?` | 记一笔账。`from`/`to` 的格式为 `{ "account": "家机A" }` 或 `{ "external": "XX公司" }` |
| `list_transactions` | `account?`, `limit?`, `include_voided?` | 查看流水，按时间倒序 |
| `void_transaction` | `transaction_id`, `reason` | 撤销一笔交易 |
| `void_transactions_by_message` | `message_id` | 撤销某条消息产生的全部交易（供支持重新生成的宿主使用） |

示例：

- 领工资：`from = {external: "XX公司"}`，`to = {account: "家机A"}`
- 消费：`from = {account: "家机A"}`，`to = {external: "便利店"}`
- 主人给零花钱：`from = {account: "玩家"}`，`to = {account: "家机A"}`
- 角色互转：`from = {account: "家机A"}`，`to = {account: "家机B"}`

## 8. 鉴权

- HTTP 头 `Authorization: Bearer <api_key>`，服务端对 key 做 SHA-256 后查表，得到 `user_id`。
- 首版用管理 CLI 创建用户和签发 API Key。创建用户时自动建立玩家账户：
  - `agentwallet-admin create-user --name <name>`
  - `agentwallet-admin create-key --user <id>`
  - `agentwallet-admin revoke-key --key-id <id>`
- 后续：支持 OAuth 2.1，以便接入需要 OAuth 的客户端（例如 claude.ai 的自定义连接器）。

## 9. 技术栈

| 部分 | 选型 |
|---|---|
| 运行时 | Node.js 24 LTS，TypeScript，pnpm |
| MCP | `@modelcontextprotocol/sdk`（Streamable HTTP，无状态） |
| Web 框架 | Hono（`@hono/node-server`） |
| 数据库 | Drizzle ORM + Node 内置 `node:sqlite`（无原生依赖，经 `src/db/node-sqlite.ts` 适配；以后可切换 Postgres） |
| 校验 | zod |
| 测试 | vitest |

## 10. 目录结构（规划）

```
src/
  index.ts            # 服务入口
  config.ts
  auth/               # API Key 鉴权
  core/               # 记账核心：accounts / transactions / money / time
  db/                 # schema、连接、迁移
  mcp/                # MCP server 与工具定义
  cli/admin.ts        # 管理 CLI
test/
drizzle/              # 迁移文件
```

## 11. 已确认的决策

- 玩家账户同样受透支额度限制，默认 0（不能欠钱）。
- 不支持跨用户转账。
- 账户不能删除，只能归档；已归档账户的名称不能被新账户复用。
- 首版只支持 API Key 鉴权；需要 OAuth 的客户端（例如 claude.ai 的自定义连接器）暂不支持。

## 12. Web 管理端（v0.2）

### 12.1 部署形态

同一个端口提供三类路由：

| 路径 | 内容 | 鉴权 |
|---|---|---|
| `/mcp` | MCP 服务 | API Key（Bearer） |
| `/api/*` | Web 用 JSON 接口 | 会话 Cookie |
| `/*` | React 单页应用静态文件（`web/dist`），未知路径回退到 `index.html` | 无 |

- 仓库为 pnpm workspace：根目录是服务端，`web/` 是前端（React + Vite + TypeScript + React Router + TanStack Query）。
- `pnpm build` 同时构建服务端和前端，前端在 VPS 上直接构建。
- 本地开发时另起 Vite 开发服务器（5173），把 `/api`、`/mcp` 代理到服务端；生产只有一个端口。
- 样式用手写 CSS 和 CSS 变量，不引入 Tailwind，以减少原生依赖和构建内存。字体 Inter 随包打包，不依赖 Google Fonts。

### 12.2 用户、角色与权限

- 每个用户有 1 个"我的钱包"（`player` 账户）和多个"Agent 钱包"（`character` 账户）。界面上称 Agent，数据库和 MCP 接口不变。
- 角色：`user` 只能管理自己的钱包、流水、API Key；`admin` 额外可管理用户账号（创建、重置密码、停用、设为管理员），**不能查看或操作其他用户的钱包**。
- 不开放注册。首个管理员通过 CLI 创建。
- 管理员不能停用或降级自己，系统至少保留一个未停用的管理员。
- 停用用户后，其会话和 API Key 立即失效。

### 12.3 数据模型变更

```
users (+)
  username        text unique null   -- 登录名；旧用户为空，需补设后才能登录
  password_hash   text null          -- scrypt（node:crypto），格式 scrypt$N$r$p$salt$hash
  role            text default 'user' -- 'admin' | 'user'
  disabled_at     integer null

sessions
  id              text pk            -- 会话令牌的 SHA-256
  user_id         text fk -> users
  created_at      integer
  expires_at      integer            -- 30 天，活跃使用时滑动续期
```

- 登录名 3–32 位，限字母、数字、`_`、`.`、`-`；密码至少 8 位。
- 修改或重置密码时，该用户的其他会话全部失效。

### 12.4 安全

- 会话 Cookie `aw_session`：`HttpOnly`、`SameSite=Lax`、`Path=/`；HTTPS 请求（含反代头 `X-Forwarded-Proto: https`）时加 `Secure`。
- 所有修改类请求校验 `Origin` 与 `Host`（或 `X-Forwarded-Host`）一致，防 CSRF。
- 登录失败限流：同一"用户名 + IP"15 分钟内失败 5 次后暂时拒绝（内存计数）。

### 12.5 接口（前缀 `/api`）

金额：响应中为**整数分**；请求中为**元**（字符串或数字，最多两位小数），与 MCP 规则一致。时间：响应中为 UTC 毫秒时间戳，前端按 Asia/Shanghai 显示。

| 分组 | 接口 |
|---|---|
| 认证 | `POST /auth/login` · `POST /auth/logout` · `GET /me` · `POST /me/password` |
| 钱包 | `GET /summary` · `GET /accounts` · `POST /accounts` · `GET /accounts/:id` · `PATCH /accounts/:id` · `POST /accounts/:id/archive` |
| 流水 | `GET /transactions?account=&direction=in\|out\|internal&status=active\|voided\|all&cursor=&limit=` · `POST /transactions` · `POST /transactions/:id/void` |
| API Key | `GET /keys` · `POST /keys` · `DELETE /keys/:id` |
| 推送 | `GET /events`（SSE，钱包数据变化时推送 `change` 事件） |
| 管理员 | `GET /admin/users` · `POST /admin/users` · `PATCH /admin/users/:id` · `POST /admin/users/:id/password` |

- Web 接口按账户 ID 操作，MCP 仍按账户名。
- `direction`：指定账户时相对该账户（in 收入 / out 支出 / internal 与自己其他钱包之间的转账）；不指定时相对整个用户（in 来自外部 / out 付给外部 / internal 内部转账）。
- 分页为游标分页（按时间倒序）。
- 推送基于进程内事件总线；MCP 和 Web 的写操作都会触发。

### 12.6 页面

| 页面 | 内容 |
|---|---|
| 登录 | 用户名、密码 |
| 总览 | 总资产、本月收入/支出、我的钱包、Agent 钱包卡片、最近流水 |
| 钱包详情 | 余额/可用/透支额度；记账、编辑、归档；流水（筛选 + 加载更多） |
| 流水 | 全部钱包流水，可筛选 |
| API Keys | 创建（仅显示一次）、吊销 |
| 设置 | 修改密码、退出登录 |
| 用户管理（管理员） | 用户列表、新建用户、重置密码、停用/启用、设为管理员 |

- 记账弹窗分"收入 / 支出 / 转账"三种，分别映射为"外部 → 钱包""钱包 → 外部""钱包 → 钱包"。
- 布局：桌面端左侧导航；手机端底部标签栏（总览 / 流水 / ＋记账 / 我的）。
- 视觉：参考 Wise 的极简风格。大量留白，大号粗体金额，数字用等宽字形，胶囊按钮；深墨绿 `#163300` + 荧光绿 `#9FE870`；深色模式跟随系统。金额显示为 `8,000.00 元`。
