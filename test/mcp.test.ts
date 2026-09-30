import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserService } from '../src/core/users.js';
import { openDb } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';

let app: ReturnType<typeof createApp>;
let users: UserService;
let client: Client;

async function connect(apiKey: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL('http://wallet.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  );
  return c;
}

async function call(name: string, args: Record<string, unknown> = {}, c = client) {
  const res = (await c.callTool({ name, arguments: args })) as CallToolResult;
  const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
  return { isError: res.isError ?? false, text, data: res.isError ? undefined : JSON.parse(text) };
}

beforeEach(async () => {
  const db = openDb(':memory:');
  app = createApp(db);
  users = new UserService(db);
  const user = users.createUser({ name: 'neo' });
  client = await connect(users.createApiKey(user.id).key);
});

afterEach(async () => {
  await client.close();
});

describe('HTTP', () => {
  it('rejects requests without a valid API key', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const bad = await app.request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer aw_nope' }, body: '{}' });
    expect(bad.status).toBe(401);
  });

  it('serves a health check', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
  });
});

describe('MCP tools', () => {
  it('exposes the wallet tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'archive_account',
      'create_account',
      'get_balance',
      'list_accounts',
      'list_transactions',
      'record_transaction',
      'update_account',
      'void_transaction',
      'void_transactions_by_message',
    ]);
    expect(client.getInstructions()).toContain('虚拟钱包');
  });

  it('runs a role-play money story end to end', async () => {
    await call('create_account', { name: '家机A', initial_balance: 100 });

    const salary = await call('record_transaction', {
      from: { external: 'XX公司' },
      to: { account: '家机A' },
      amount: 8000,
      reason: '九月工资',
    });
    expect(salary.data.transaction).toMatchObject({ amount: '8000.00', from: { external: 'XX公司' } });
    expect(salary.data.balances).toEqual([expect.objectContaining({ name: '家机A', balance: '8100.00' })]);

    const spend = await call('record_transaction', {
      from: { account: '家机A' },
      to: { external: '便利店' },
      amount: '12.50',
      reason: '零食',
    });
    expect(spend.data.balances[0].balance).toBe('8087.50');

    const pocketMoney = await call('record_transaction', {
      from: { account: '玩家' },
      to: { account: '家机A' },
      amount: 500,
      reason: '零花钱',
    });
    expect(pocketMoney.isError).toBe(true);
    expect(pocketMoney.text).toContain('INSUFFICIENT_FUNDS');

    const history = await call('list_transactions', { account: '家机A' });
    expect(history.data.transactions.map((t: { change: string }) => t.change)).toEqual([
      '-12.50',
      '+8000.00',
      '+100.00',
    ]);
    expect(history.data.transactions[0].time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const undo = await call('void_transaction', { transaction_id: spend.data.transaction.id, reason: '剧情回退' });
    expect(undo.data.transaction.status).toBe('voided');
    expect((await call('get_balance', { account: '家机A' })).data.balance).toBe('8100.00');
  });

  it('reports invalid amounts and unknown accounts as tool errors', async () => {
    const bad = await call('record_transaction', {
      from: { external: 'x' },
      to: { account: '玩家' },
      amount: 1.234,
      reason: 'x',
    });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain('最多两位小数');

    const unknown = await call('get_balance', { account: '不存在' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('可用账户：「玩家」');
  });

  it('keeps each API key scoped to its own user', async () => {
    await call('create_account', { name: '家机A' });
    const other = users.createUser({ name: 'bob' });
    const otherClient = await connect(users.createApiKey(other.id).key);
    try {
      const res = await call('list_accounts', {}, otherClient);
      expect(res.data.accounts.map((a: { name: string }) => a.name)).toEqual(['玩家']);
    } finally {
      await otherClient.close();
    }
  });
});
