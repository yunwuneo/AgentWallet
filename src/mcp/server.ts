import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { WalletError } from '../core/errors.js';
import { parseMoney } from '../core/money.js';
import type { WalletService } from '../core/wallet.js';
import { presentAccount, presentTransaction } from './present.js';

const INSTRUCTIONS = `AgentWallet 是角色扮演用的虚拟钱包，只在剧情中有效，与真实支付无关。

- 当剧情中发生金钱往来（领工资、消费、转账、收到零花钱等）时，调用 record_transaction 记账。
- 金额单位为"元"，最多两位小数。
- 每笔交易有付款方 from 和收款方 to，各自是钱包账户 {"account": "账户名"} 或外部对象 {"external": "名称"}，至少一方是账户。
- 不确定有哪些账户时，先调用 list_accounts。
- 余额不足会被拒绝，此时请让剧情合理应对（例如钱不够买不起）。
- 记错了可以用 void_transaction 撤销。`;

const money = z
  .union([z.number(), z.string()])
  .describe('金额，单位元，最多两位小数，例如 8000 或 "12.50"');

const party = z.union([
  z.object({ account: z.string().describe('钱包账户名，例如 "家机A"') }).strict(),
  z.object({ external: z.string().describe('外部对象名称，例如 "XX公司"、"便利店"') }).strict(),
]);

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Runs `fn`, turning business-rule failures into tool errors the model can read and recover from. */
function handle(fn: () => unknown): CallToolResult {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof WalletError) {
      return { isError: true, content: [{ type: 'text', text: `[${err.code}] ${err.message}` }] };
    }
    throw err;
  }
}

/** Builds an MCP server whose tools all act on behalf of the wallet's user. */
export function createMcpServer(wallet: WalletService): McpServer {
  const server = new McpServer({ name: 'agentwallet', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'list_accounts',
    {
      title: '列出账户',
      description: '列出当前用户的所有钱包账户（玩家和角色）及其余额、透支额度、可用额度。',
      inputSchema: {
        include_archived: z.boolean().optional().describe('是否包含已归档账户，默认否'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ include_archived }) =>
      handle(() => ({ accounts: wallet.listAccounts({ includeArchived: include_archived }).map(presentAccount) })),
  );

  server.registerTool(
    'get_balance',
    {
      title: '查询余额',
      description: '查询单个账户的余额、透支额度和可用额度（余额 + 透支额度）。',
      inputSchema: { account: z.string().describe('账户名') },
      annotations: { readOnlyHint: true },
    },
    ({ account }) => handle(() => presentAccount(wallet.getAccount(account))),
  );

  server.registerTool(
    'create_account',
    {
      title: '创建角色账户',
      description: '为一个角色创建钱包账户。账户名在当前用户下必须唯一。',
      inputSchema: {
        name: z.string().describe('账户名，通常是角色名'),
        initial_balance: money.optional().describe('初始余额（元），默认 0；可为负数，但不能低于 -透支额度'),
        overdraft_limit: money.optional().describe('透支额度（元），即最多可欠多少，默认 0（不能欠钱）'),
      },
    },
    ({ name, initial_balance, overdraft_limit }) =>
      handle(() =>
        presentAccount(
          wallet.createAccount({
            name,
            initialBalance:
              initial_balance === undefined ? 0 : parseMoney(initial_balance, { allowZero: true, allowNegative: true }),
            overdraftLimit: overdraft_limit === undefined ? 0 : parseMoney(overdraft_limit, { allowZero: true }),
          }),
        ),
      ),
  );

  server.registerTool(
    'update_account',
    {
      title: '修改账户',
      description: '修改账户名称或透支额度。',
      inputSchema: {
        account: z.string().describe('当前账户名'),
        new_name: z.string().optional().describe('新账户名'),
        overdraft_limit: money.optional().describe('新的透支额度（元），0 表示不能欠钱'),
      },
    },
    ({ account, new_name, overdraft_limit }) =>
      handle(() =>
        presentAccount(
          wallet.updateAccount(account, {
            newName: new_name,
            overdraftLimit: overdraft_limit === undefined ? undefined : parseMoney(overdraft_limit, { allowZero: true }),
          }),
        ),
      ),
  );

  server.registerTool(
    'archive_account',
    {
      title: '归档账户',
      description: '归档一个角色账户。归档后不能再记账，历史流水保留。玩家账户不能归档。',
      inputSchema: { account: z.string().describe('账户名') },
      annotations: { destructiveHint: true },
    },
    ({ account }) => handle(() => presentAccount(wallet.archiveAccount(account))),
  );

  server.registerTool(
    'record_transaction',
    {
      title: '记账',
      description:
        '记录一笔剧情中的金钱往来。示例：' +
        '领工资 from={"external":"XX公司"} to={"account":"家机A"}；' +
        '消费 from={"account":"家机A"} to={"external":"便利店"}；' +
        '主人给零花钱 from={"account":"玩家"} to={"account":"家机A"}；' +
        '角色互转 from={"account":"家机A"} to={"account":"家机B"}。' +
        '付款方是账户时会检查余额，超出透支额度会被拒绝。',
      inputSchema: {
        from: party.describe('付款方'),
        to: party.describe('收款方'),
        amount: money,
        reason: z.string().describe('事由，例如 "九月工资"、"买菜"'),
        message_id: z.string().optional().describe('（可选）触发这笔交易的聊天消息 ID，便于重新生成时批量撤销'),
        idempotency_key: z.string().optional().describe('（可选）幂等键；同一个键重复提交只会记一次'),
      },
    },
    ({ from, to, amount, reason, message_id, idempotency_key }) =>
      handle(() => {
        const { transaction, duplicate } = wallet.recordTransaction({
          from,
          to,
          amount: parseMoney(amount),
          reason,
          messageId: message_id,
          idempotencyKey: idempotency_key,
        });
        const balances = [transaction.from, transaction.to]
          .filter((p) => p.kind === 'account')
          .map((p) => presentAccount(wallet.getAccountById(p.id)));
        return { transaction: presentTransaction(transaction), duplicate, balances };
      }),
  );

  server.registerTool(
    'list_transactions',
    {
      title: '查看流水',
      description: '按时间倒序列出交易流水。指定账户时，每笔会带上该账户视角的 change（+收入 / -支出）。',
      inputSchema: {
        account: z.string().optional().describe('只看某个账户的流水'),
        limit: z.number().int().min(1).max(100).optional().describe('条数，默认 20，最多 100'),
        include_voided: z.boolean().optional().describe('是否包含已撤销的交易，默认否'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ account, limit, include_voided }) =>
      handle(() => {
        const perspective = account ? wallet.getAccount(account, { allowArchived: true }).id : undefined;
        const txs = wallet.listTransactions({ account, limit, includeVoided: include_voided });
        return { transactions: txs.map((t) => presentTransaction(t, perspective)) };
      }),
  );

  server.registerTool(
    'void_transaction',
    {
      title: '撤销交易',
      description: '撤销一笔记错或因剧情回退而作废的交易。撤销后不再计入余额，但流水中保留记录。',
      inputSchema: {
        transaction_id: z.string().describe('交易 ID，例如 "tx_8f3k2m9q7w1c"'),
        reason: z.string().describe('撤销原因'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ transaction_id, reason }) =>
      handle(() => ({ transaction: presentTransaction(wallet.voidTransaction(transaction_id, reason)) })),
  );

  server.registerTool(
    'void_transactions_by_message',
    {
      title: '按消息撤销',
      description: '撤销某条聊天消息产生的全部交易，供聊天程序在消息被重新生成或删除时调用。',
      inputSchema: {
        message_id: z.string().describe('消息 ID（记账时传入的 message_id）'),
        reason: z.string().optional().describe('撤销原因，默认"消息已重新生成或删除"'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ message_id, reason }) =>
      handle(() => ({
        voided: wallet.voidTransactionsByMessage(message_id, reason).map((t) => presentTransaction(t)),
      })),
  );

  return server;
}
