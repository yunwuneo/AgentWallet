# AgentWallet 设计文档

> 状态：v0.1 已实现（2026-09-30）

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
- Web / App 管理端
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
