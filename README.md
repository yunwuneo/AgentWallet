# AgentWallet

角色扮演用的虚拟钱包 MCP 服务：给玩家和角色（家机）记账。剧情里领了工资、买了东西、互相转账，都记到钱包里。只在剧情中有效，不对接任何真实支付。

设计细节见 [DESIGN.md](DESIGN.md)。

## 快速开始

```bash
pnpm install
pnpm build

# 创建用户（同时创建玩家账户）并签发 API Key
node dist/cli/admin.js create-user --name neo --player-name 主人 --with-key

# 启动服务（MCP 端点：POST /mcp）
PORT=8787 DATABASE_PATH=./data/agentwallet.db pnpm start
```

开发时可用 `pnpm dev`（热重载）和 `pnpm admin <command>`（直接运行 TS 源码）。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATABASE_PATH` | `./data/agentwallet.db` | SQLite 文件路径，启动时自动迁移 |

生产环境请放在 HTTPS 反向代理之后，API Key 会通过请求头传输。

## 接入 MCP 客户端

传输方式为 Streamable HTTP，鉴权头为 `Authorization: Bearer <api_key>`。

Claude Code：

```bash
claude mcp add --transport http agentwallet https://your-host/mcp \
  --header "Authorization: Bearer aw_xxx"
```

自研聊天程序：使用 `@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`，在 `requestInit.headers` 中带上同样的鉴权头。消息被重新生成或删除时，调用 `void_transactions_by_message` 撤销该消息产生的交易（记账时需传入 `message_id`）。

## 管理 CLI

```
agentwallet-admin create-user --name <name> [--player-name <name>] [--with-key]
agentwallet-admin list-users
agentwallet-admin create-key --user <id> [--label <label>]
agentwallet-admin list-keys --user <id>
agentwallet-admin revoke-key --key-id <id>
```

## 开发

```bash
pnpm test        # vitest
pnpm typecheck
pnpm db:generate # 修改 src/db/schema.ts 后生成迁移
```
