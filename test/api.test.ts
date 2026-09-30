import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WalletEvents } from '../src/core/events.js';
import { UserService } from '../src/core/users.js';
import { WalletService } from '../src/core/wallet.js';
import { openDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';

const ORIGIN = 'http://wallet.test';

let db: Db;
let events: WalletEvents;
let app: ReturnType<typeof createApp>;
let users: UserService;

/** Minimal browser-like client: keeps the session cookie and sends a same-origin Origin header. */
class Browser {
  cookie = '';

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Host: 'wallet.test',
        ...(method !== 'GET' ? { Origin: ORIGIN } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    const json = text && res.headers.get('Content-Type')?.includes('json') ? JSON.parse(text) : undefined;
    return { status: res.status, json, text, headers: res.headers };
  }

  get = (path: string) => this.req('GET', path);
  post = (path: string, body: unknown = {}) => this.req('POST', path, body);
  patch = (path: string, body: unknown) => this.req('PATCH', path, body);
  del = (path: string) => this.req('DELETE', path);

  async login(username: string, password: string) {
    const res = await this.post('/api/auth/login', { username, password });
    expect(res.status).toBe(200);
    return res;
  }
}

beforeEach(() => {
  db = openDb(':memory:');
  events = new WalletEvents();
  app = createApp(db, { events, heartbeatMs: 20 });
  users = new UserService(db);
  users.createUser({ username: 'root', password: 'rootpass1', role: 'admin', name: '管理员' });
  users.createUser({ username: 'neo', password: 'neopass12', playerName: '主人' });
});

describe('auth', () => {
  it('logs in, reads /me, logs out', async () => {
    const b = new Browser();
    expect((await b.get('/api/me')).status).toBe(401);
    const login = await b.login('neo', 'neopass12');
    expect(login.json.user).toMatchObject({ username: 'neo', role: 'user' });
    expect(login.json.user).not.toHaveProperty('passwordHash');
    expect(login.headers.get('Set-Cookie')).toMatch(/aw_session=.+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax/);

    expect((await b.get('/api/me')).json.user.username).toBe('neo');
    expect((await b.post('/api/auth/logout')).status).toBe(204);
    expect((await b.get('/api/me')).status).toBe(401);
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const b = new Browser();
    const res = await b.req('POST', '/api/auth/login', { username: 'neo', password: 'neopass12' }, {
      'X-Forwarded-Proto': 'https',
    });
    expect(res.headers.get('Set-Cookie')).toContain('Secure');
  });

  it('rejects bad credentials and rate-limits repeated failures', async () => {
    const b = new Browser();
    for (let i = 0; i < 5; i++) {
      expect((await b.post('/api/auth/login', { username: 'neo', password: 'wrong-pass' })).status).toBe(401);
    }
    expect((await b.post('/api/auth/login', { username: 'neo', password: 'neopass12' })).status).toBe(429);
    expect((await b.post('/api/auth/login', { username: 'nobody', password: 'whatever1' })).status).toBe(401);
  });

  it('blocks cross-site state-changing requests', async () => {
    const b = new Browser();
    await b.login('neo', 'neopass12');
    const evil = await b.req('POST', '/api/accounts', { name: 'x' }, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const noOrigin = await b.req('POST', '/api/accounts', { name: 'x' }, { Origin: '' });
    expect(noOrigin.status).toBe(403);
  });

  it('changes password, keeping this session and ending others', async () => {
    const a = new Browser();
    const other = new Browser();
    await a.login('neo', 'neopass12');
    await other.login('neo', 'neopass12');

    expect((await a.post('/api/me/password', { current: 'wrong-pass', next: 'newpass123' })).status).toBe(400);
    expect((await a.post('/api/me/password', { current: 'neopass12', next: 'newpass123' })).status).toBe(204);
    expect((await a.get('/api/me')).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    await new Browser().login('neo', 'newpass123');
  });

  it('returns JSON 404 for unknown API paths', async () => {
    const b = new Browser();
    await b.login('neo', 'neopass12');
    const res = await b.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('NOT_FOUND');
  });
});

describe('wallets and transactions', () => {
  let b: Browser;
  beforeEach(async () => {
    b = new Browser();
    await b.login('neo', 'neopass12');
  });

  it('manages agent wallets by id', async () => {
    const created = await b.post('/api/accounts', { name: '家机A', initialBalance: '100', overdraftLimit: 50 });
    expect(created.status).toBe(201);
    const { id } = created.json.account;
    expect(created.json.account).toMatchObject({ kind: 'character', balance: 10000, overdraftLimit: 5000, available: 15000 });

    const renamed = await b.patch(`/api/accounts/${id}`, { name: '小爱', overdraftLimit: '0' });
    expect(renamed.json.account).toMatchObject({ id, name: '小爱', overdraftLimit: 0 });

    expect((await b.post('/api/accounts', { name: '小爱' })).status).toBe(409);
    expect((await b.get('/api/accounts/acc_missing')).status).toBe(404);

    const archived = await b.post(`/api/accounts/${id}/archive`);
    expect(archived.json.account.archivedAt).toEqual(expect.any(Number));
    expect((await b.get('/api/accounts')).json.accounts.map((a: { name: string }) => a.name)).toEqual(['主人']);
    expect((await b.get('/api/accounts?include_archived=1')).json.accounts).toHaveLength(2);
  });

  it('records, filters, paginates and voids transactions', async () => {
    const agent = (await b.post('/api/accounts', { name: '家机A' })).json.account.id;
    const player = (await b.get('/api/accounts')).json.accounts[0].id;

    const salary = await b.post('/api/transactions', {
      from: { external: 'XX公司' },
      to: { accountId: agent },
      amount: 8000,
      reason: '工资',
    });
    expect(salary.status).toBe(201);
    expect(salary.json.transaction).toMatchObject({ amount: 800000, from: { kind: 'external', name: 'XX公司' } });

    await b.post('/api/transactions', { from: { accountId: agent }, to: { accountId: player }, amount: '1000', reason: '孝敬' });
    await b.post('/api/transactions', { from: { accountId: agent }, to: { external: '便利店' }, amount: '12.5', reason: '零食' });

    const tooMuch = await b.post('/api/transactions', {
      from: { accountId: player },
      to: { external: '商场' },
      amount: 99999,
      reason: '买买买',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.json.error).toBe('INSUFFICIENT_FUNDS');

    const reasons = async (query: string) =>
      (await b.get(`/api/transactions?${query}`)).json.items.map((t: { reason: string }) => t.reason);
    expect(await reasons('')).toEqual(['零食', '孝敬', '工资']);
    expect(await reasons('direction=in')).toEqual(['工资']);
    expect(await reasons('direction=out')).toEqual(['零食']);
    expect(await reasons('direction=internal')).toEqual(['孝敬']);
    expect(await reasons(`account=${player}`)).toEqual(['孝敬']);
    expect(await reasons(`account=${agent}&direction=out`)).toEqual(['零食', '孝敬']);

    const page1 = (await b.get('/api/transactions?limit=2')).json;
    expect(page1.items).toHaveLength(2);
    const page2 = (await b.get(`/api/transactions?limit=2&cursor=${page1.nextCursor}`)).json;
    expect(page2.items.map((t: { reason: string }) => t.reason)).toEqual(['工资']);
    expect(page2.nextCursor).toBeNull();

    const voided = await b.post(`/api/transactions/${salary.json.transaction.id}/void`, { reason: '记错了' });
    expect(voided.json.transaction.status).toBe('voided');
    expect(await reasons('status=voided')).toEqual(['工资']);

    const summary = (await b.get('/api/summary')).json;
    expect(summary.total).toBe(-1250 - 100000 + 100000);
    expect(summary.month).toEqual({ income: 0, expense: 1250 });
  });

  it('validates input', async () => {
    const res = await b.post('/api/transactions', { from: { external: 'a' }, to: { accountId: 'x' }, amount: 'abc', reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('INVALID_AMOUNT');
    const bad = await b.post('/api/transactions', { from: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('INVALID_INPUT');
  });

  it('never exposes another user\'s wallets', async () => {
    const rootAccount = new WalletService(db, users.listUsers()[0]!.id).listAccounts()[0]!;
    expect((await b.get(`/api/accounts/${rootAccount.id}`)).status).toBe(404);
    const steal = await b.post('/api/transactions', {
      from: { accountId: rootAccount.id },
      to: { external: 'x' },
      amount: 1,
      reason: 'x',
    });
    expect(steal.status).toBe(404);
  });
});

describe('api keys', () => {
  it('creates, lists and revokes own keys only', async () => {
    const b = new Browser();
    await b.login('neo', 'neopass12');
    const created = await b.post('/api/keys', { label: 'SillyTavern' });
    expect(created.status).toBe(201);
    expect(created.json.key).toMatch(/^aw_/);
    const listed = (await b.get('/api/keys')).json.keys;
    expect(listed).toEqual([expect.objectContaining({ id: created.json.id, label: 'SillyTavern', revokedAt: null })]);
    expect(listed[0]).not.toHaveProperty('keyHash');

    const root = new Browser();
    await root.login('root', 'rootpass1');
    expect((await root.del(`/api/keys/${created.json.id}`)).status).toBe(404);
    expect((await b.del(`/api/keys/${created.json.id}`)).status).toBe(204);
    expect(users.authenticate(created.json.key)).toBeUndefined();
  });
});

describe('admin', () => {
  it('requires the admin role', async () => {
    const b = new Browser();
    await b.login('neo', 'neopass12');
    expect((await b.get('/api/admin/users')).status).toBe(403);
  });

  it('creates users, resets passwords, disables and promotes', async () => {
    const root = new Browser();
    await root.login('root', 'rootpass1');

    const created = await root.post('/api/admin/users', { username: 'amy', password: 'amypass12', name: 'Amy' });
    expect(created.status).toBe(201);
    const amyId = created.json.user.id;
    expect((await root.post('/api/admin/users', { username: 'amy', password: 'amypass12' })).status).toBe(409);
    expect((await root.post('/api/admin/users', { username: 'x', password: 'short' })).status).toBe(400);

    const amy = new Browser();
    await amy.login('amy', 'amypass12');
    expect((await amy.get('/api/accounts')).json.accounts[0]).toMatchObject({ kind: 'player', name: '玩家' });

    expect((await root.post(`/api/admin/users/${amyId}/password`, { password: 'newamy123' })).status).toBe(204);
    expect((await amy.get('/api/me')).status).toBe(401);
    await amy.login('amy', 'newamy123');

    const apiKey = users.createApiKey(amyId).key;
    expect((await root.patch(`/api/admin/users/${amyId}`, { disabled: true })).json.user.disabledAt).toEqual(expect.any(Number));
    expect((await amy.get('/api/me')).status).toBe(401);
    expect((await amy.post('/api/auth/login', { username: 'amy', password: 'newamy123' })).status).toBe(401);
    expect(users.authenticate(apiKey)).toBeUndefined();

    expect((await root.patch(`/api/admin/users/${amyId}`, { disabled: false, role: 'admin' })).json.user).toMatchObject({
      role: 'admin',
      disabledAt: null,
    });
  });

  it('protects admins from locking themselves out', async () => {
    const root = new Browser();
    const me = (await root.login('root', 'rootpass1')).json.user.id;
    expect((await root.patch(`/api/admin/users/${me}`, { role: 'user' })).status).toBe(403);
    expect((await root.patch(`/api/admin/users/${me}`, { disabled: true })).status).toBe(403);
  });

  it('keeps at least one active admin', () => {
    const [rootUser, neo] = users.listUsers();
    users.updateUser(rootUser!.id, neo!.id, { role: 'admin' });
    users.updateUser(neo!.id, rootUser!.id, { role: 'user' });
    expect(() => users.updateUser('cli', neo!.id, { disabled: true })).toThrow(/至少需要保留一个/);
  });
});

describe('live updates', () => {
  it('pushes a change event over SSE when MCP or the web writes', async () => {
    const b = new Browser();
    await b.login('neo', 'neopass12');
    const res = await app.request(`${ORIGIN}/api/events`, { headers: { Cookie: b.cookie, Host: 'wallet.test' } });
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (needle: string) => {
      while (!received.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };

    await readUntil('event: ready');
    const neoId = users.listUsers()[1]!.id;
    // A write from another path (e.g. the MCP tools) on the shared event bus:
    new WalletService(db, neoId, { events }).createAccount({ name: '家机A' });
    await readUntil('event: change');
    expect(received).toContain('"scope":"accounts"');
    await reader.cancel();
  });
});

describe('web console hosting', () => {
  it('serves the SPA with fallback and keeps /mcp and /api separate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-web-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AgentWallet</title>');
      const web = createApp(db, { webDist: dir });
      const root = await web.request('/');
      expect(await root.text()).toContain('<title>AgentWallet</title>');
      const deep = await web.request('/accounts/acc_123');
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('<title>AgentWallet</title>');
      expect((await web.request('/api/me')).status).toBe(401);
      expect((await web.request('/mcp', { method: 'POST' })).status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('demo entry', () => {
  const demoApp = (demo: Record<string, unknown> = {}) => {
    app = createApp(db, { events, demo: { enabled: true, ...demo } });
  };

  it('is off by default', async () => {
    const b = new Browser();
    expect((await b.get('/api/config')).json).toEqual({ demo: { enabled: false, ttlHours: 24 } });
    expect((await b.post('/api/auth/demo')).status).toBe(404);
  });

  it('gives each visitor an isolated, pre-seeded sandbox', async () => {
    demoApp();
    const a = new Browser();
    const b = new Browser();
    expect((await a.get('/api/config')).json.demo.enabled).toBe(true);

    const res = await a.post('/api/auth/demo');
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({ role: 'user', username: null, demoExpiresAt: expect.any(Number) });
    await b.post('/api/auth/demo');

    const summary = (await a.get('/api/summary')).json;
    expect(summary.accounts.map((x: { name: string }) => x.name)).toEqual(['主人', '家机A', '家机B', '小爱']);
    expect((await a.get('/api/transactions?limit=100')).json.items.length).toBeGreaterThan(8);
    expect((await a.get('/api/transactions?status=voided')).json.items).toHaveLength(1);

    const agent = summary.accounts[1].id;
    await a.post('/api/transactions', { from: { accountId: agent }, to: { external: '店' }, amount: 1, reason: 'x' });
    expect((await b.get('/api/summary')).json.total).toBe(summary.total);
    expect((await b.get(`/api/accounts/${agent}`)).status).toBe(404);

    // Demo users can connect MCP, but never appear in (or reach) user administration.
    const { key } = (await a.post('/api/keys', { label: 'demo' })).json;
    expect(users.authenticate(key)).toBe(res.json.user.id);
    expect((await a.get('/api/admin/users')).status).toBe(403);
    const root = new Browser();
    await root.login('root', 'rootpass1');
    expect((await root.get('/api/admin/users')).json.users.map((u: { username: string }) => u.username)).toEqual([
      'root',
      'neo',
    ]);
  });

  it('limits creations per IP and in total', async () => {
    demoApp({ perIpPerHour: 2 });
    const b = new Browser();
    expect((await b.post('/api/auth/demo')).status).toBe(201);
    expect((await b.post('/api/auth/demo')).status).toBe(201);
    expect((await b.post('/api/auth/demo')).status).toBe(429);

    demoApp({ maxActive: 2 });
    expect((await new Browser().post('/api/auth/demo')).status).toBe(503);
  });
});
