# AgentWallet

角色扮演用的虚拟钱包：给玩家和 Agent（家机）记账。剧情里领了工资、买了东西、互相转账，都记到钱包里。只在剧情中有效，不对接任何真实支付。

- **MCP 服务**（`/mcp`）：大模型在角色扮演中通过工具记账。
- **Web 管理端**（`/`）：查看余额与流水、手动记账、管理 Agent 钱包和 API Key；管理员可管理用户。MCP 记账后页面会实时刷新。

两者运行在同一个端口上。设计细节见 [DESIGN.md](DESIGN.md)。

## 快速开始

```bash
pnpm install
pnpm build        # 构建服务端和 Web 前端

# 创建首个管理员（同时创建"我的钱包"）
pnpm admin create-user --username neo --password '至少8位的密码' --admin --player-name 主人

pnpm start        # http://localhost:8787 打开 Web 管理端；MCP 端点为 /mcp
```

登录 Web 管理端后，在「API Keys」页创建 Key，页面会给出 MCP 地址和接入命令。

### 从 v0.1 升级

数据库会在启动时自动迁移，已有钱包和流水不受影响。之前用 CLI 创建的用户没有登录名和密码，需要补设后才能登录 Web：

```bash
pnpm admin list-users
pnpm admin set-login --user <用户ID> --username neo --password '至少8位的密码'
pnpm admin set-role --user <用户ID> --role admin      # 设为管理员
```

也可以由管理员在「用户管理」页点「设置登录」。

### 环境变量

可以直接设置环境变量，也可以写在项目根目录的 `.env` 文件里（参考 `.env.example`）。服务和管理 CLI 启动时都会读取 `.env`；同名变量如果已经在环境中设置，以环境中的为准。

```bash
cp .env.example .env   # Windows: copy .env.example .env
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATABASE_PATH` | `./data/agentwallet.db` | SQLite 文件路径，启动时自动迁移 |
| `DEMO_ENABLED` | `false` | 设为 `true` 时登录页显示「体验演示」入口 |
| `DEMO_TTL_HOURS` | `24` | 演示账号的有效期（小时） |

### 演示入口

`DEMO_ENABLED=true` 时，登录页会出现「体验演示」按钮。每位访客点击后获得一个**独立的临时账号**，预置 1 个「我的钱包」、3 个 Agent 钱包和约两周的示例流水，可以随意记账、撤销、新建 Agent，也可以创建 API Key 真实接入 MCP。

- 访客之间互不可见；演示账号不出现在「用户管理」里，也没有管理权限。
- 到期后登录会话和 API Key 立即失效，服务每 10 分钟删除一次过期演示账号的全部数据。
- 防滥用：同一 IP 每小时最多创建 5 个；同时存在的演示账号最多 200 个。
- 关闭入口后，已创建的演示账号仍会按期清除。`pnpm admin list-users` 会标出演示账号。

## 部署

- 生产环境请放在 HTTPS 反向代理之后（登录 Cookie 和 API Key 都需要加密传输）。服务会根据 `X-Forwarded-Proto: https` 给 Cookie 加上 `Secure`。
- 反向代理需转发 `Host`（或设置 `X-Forwarded-Host`），否则 Web 端的修改请求会被来源校验拒绝。
- 实时刷新使用 SSE（`/api/events`）。nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;          # SSE 需要
    proxy_read_timeout 1h;
}
```

- 内存参考（Debian 11 实测峰值）：`pnpm install` 约 860MB，`pnpm build` 约 480MB，运行时约 60–100MB。VPS 内存小于 1GB 时建议先加 1–2GB swap，否则安装可能被系统终止。

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
agentwallet-admin create-user (--name <name> | --username <login>) [--password <pw>] [--admin]
                              [--player-name <name>] [--with-key]
agentwallet-admin list-users
agentwallet-admin set-login --user <id> [--username <login>] [--password <pw>]
agentwallet-admin set-role --user <id> --role <admin|user>
agentwallet-admin create-key --user <id> [--label <label>]
agentwallet-admin list-keys --user <id>
agentwallet-admin revoke-key --key-id <id>
```

开发时用 `pnpm admin <command>` 直接运行源码。注意 `--password` 会留在 shell 历史里，可在命令前加一个空格（多数 shell 下不记录），或事后在 Web 端修改。

## 开发

```bash
pnpm dev          # 服务端（热重载），端口 8787
pnpm dev:web      # 前端开发服务器 http://localhost:5173，/api 与 /mcp 代理到 8787
pnpm test         # vitest
pnpm typecheck    # 服务端 + 前端
pnpm db:generate  # 修改 src/db/schema.ts 后生成迁移
```

前端代码在 `web/`（React + Vite），生产构建输出到 `web/dist`，由服务端直接提供。
