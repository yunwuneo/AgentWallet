import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import { SESSION_TTL_MS, UserService } from '../src/core/users.js';
import { WalletService } from '../src/core/wallet.js';
import { createDemoUser } from '../src/core/demo.js';

let db: Db;
let users: UserService;
let wallet: WalletService;

beforeEach(() => {
  db = openDb(':memory:');
  users = new UserService(db);
  const user = users.createUser({ name: 'neo', playerName: '主人' });
  wallet = new WalletService(db, user.id);
});

const balance = (name: string) => wallet.getAccount(name).balance;

describe('accounts', () => {
  it('creates a player account with each user', () => {
    const [player] = wallet.listAccounts();
    expect(player).toMatchObject({ name: '主人', kind: 'player', balance: 0, overdraftLimit: 0 });
  });

  it('creates a character with an opening balance recorded as a transaction', () => {
    const acc = wallet.createAccount({ name: '家机A', initialBalance: 100000 });
    expect(acc.balance).toBe(100000);
    const [tx] = wallet.listTransactions({ account: '家机A' });
    expect(tx).toMatchObject({ type: 'opening', amount: 100000, from: { kind: 'external', name: '初始余额' } });
  });

  it('allows a negative opening balance only within the overdraft limit', () => {
    expect(() => wallet.createAccount({ name: 'A', initialBalance: -100 })).toThrow(/下限/);
    expect(wallet.createAccount({ name: 'B', initialBalance: -100, overdraftLimit: 500 }).balance).toBe(-100);
  });

  it('rejects duplicate names, including archived ones', () => {
    wallet.createAccount({ name: '家机A' });
    expect(() => wallet.createAccount({ name: '家机A' })).toThrow(/已存在/);
    wallet.archiveAccount('家机A');
    expect(() => wallet.createAccount({ name: '家机A' })).toThrow(/已归档/);
  });

  it('renames and changes overdraft limit', () => {
    wallet.createAccount({ name: '家机A' });
    const acc = wallet.updateAccount('家机A', { newName: '小爱', overdraftLimit: 20000 });
    expect(acc).toMatchObject({ name: '小爱', overdraftLimit: 20000, available: 20000 });
    expect(() => wallet.getAccount('家机A')).toThrow(/找不到账户/);
  });

  it('cannot archive the player account; archived accounts cannot transact', () => {
    expect(() => wallet.archiveAccount('主人')).toThrow(/玩家账户/);
    wallet.createAccount({ name: '家机A' });
    wallet.archiveAccount('家机A');
    expect(wallet.listAccounts().map((a) => a.name)).toEqual(['主人']);
    expect(() =>
      wallet.recordTransaction({ from: { external: '公司' }, to: { account: '家机A' }, amount: 1, reason: 'x' }),
    ).toThrow(/已归档/);
  });

  it('isolates users from each other', () => {
    wallet.createAccount({ name: '家机A' });
    const other = new WalletService(db, users.createUser({ name: 'bob' }).id);
    expect(() => other.getAccount('家机A')).toThrow(/找不到账户/);
    expect(other.listAccounts().map((a) => a.name)).toEqual(['玩家']);
  });
});

describe('transactions', () => {
  beforeEach(() => {
    wallet.createAccount({ name: '家机A' });
    wallet.createAccount({ name: '家机B' });
  });

  it('records income from an external party', () => {
    const { transaction } = wallet.recordTransaction({
      from: { external: 'XX公司' },
      to: { account: '家机A' },
      amount: 800000,
      reason: '九月工资',
    });
    expect(transaction.from).toEqual({ kind: 'external', name: 'XX公司' });
    expect(transaction.to).toMatchObject({ kind: 'account', name: '家机A' });
    expect(balance('家机A')).toBe(800000);
  });

  it('records internal transfers on both sides', () => {
    wallet.recordTransaction({ from: { external: '公司' }, to: { account: '家机A' }, amount: 1000, reason: '工资' });
    wallet.recordTransaction({ from: { account: '家机A' }, to: { account: '家机B' }, amount: 300, reason: '请客' });
    expect(balance('家机A')).toBe(700);
    expect(balance('家机B')).toBe(300);
  });

  it('enforces the overdraft limit, including for the player', () => {
    expect(() =>
      wallet.recordTransaction({ from: { account: '主人' }, to: { account: '家机A' }, amount: 50000, reason: '零花钱' }),
    ).toThrow(/余额不足.*最多还能支出 0\.00 元/);

    wallet.updateAccount('家机A', { overdraftLimit: 1000 });
    wallet.recordTransaction({ from: { account: '家机A' }, to: { external: '便利店' }, amount: 1000, reason: '零食' });
    expect(balance('家机A')).toBe(-1000);
    expect(() =>
      wallet.recordTransaction({ from: { account: '家机A' }, to: { external: '便利店' }, amount: 1, reason: '糖' }),
    ).toThrow(/余额不足/);
  });

  it('rejects external-to-external, self transfers and unknown accounts', () => {
    expect(() =>
      wallet.recordTransaction({ from: { external: 'a' }, to: { external: 'b' }, amount: 1, reason: 'x' }),
    ).toThrow(/至少一方/);
    expect(() =>
      wallet.recordTransaction({ from: { account: '家机A' }, to: { account: '家机A' }, amount: 1, reason: 'x' }),
    ).toThrow(/同一个账户/);
    expect(() =>
      wallet.recordTransaction({ from: { external: 'a' }, to: { account: '家机C' }, amount: 1, reason: 'x' }),
    ).toThrow(/可用账户：「主人」、「家机A」、「家机B」/);
  });

  it('is idempotent on idempotency_key and detects conflicting reuse', () => {
    const input = {
      from: { external: '公司' },
      to: { account: '家机A' },
      amount: 500,
      reason: '奖金',
      idempotencyKey: 'call-1',
    };
    const first = wallet.recordTransaction(input);
    const second = wallet.recordTransaction(input);
    expect(second.duplicate).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(balance('家机A')).toBe(500);
    expect(() => wallet.recordTransaction({ ...input, amount: 600 })).toThrow(/已被另一笔/);
  });

  it('voids a transaction and excludes it from the balance', () => {
    const { transaction } = wallet.recordTransaction({
      from: { external: '公司' },
      to: { account: '家机A' },
      amount: 500,
      reason: '奖金',
    });
    const voided = wallet.voidTransaction(transaction.id, '剧情回退');
    expect(voided).toMatchObject({ status: 'voided', voidReason: '剧情回退' });
    expect(balance('家机A')).toBe(0);
    expect(() => wallet.voidTransaction(transaction.id, 'again')).toThrow(/已经撤销/);
    expect(wallet.listTransactions({ account: '家机A' })).toHaveLength(0);
    expect(wallet.listTransactions({ account: '家机A', includeVoided: true })).toHaveLength(1);
  });

  it('voids everything recorded for a message', () => {
    const base = { from: { external: '公司' }, to: { account: '家机A' }, reason: 'x' } as const;
    wallet.recordTransaction({ ...base, amount: 100, messageId: 'm1' });
    wallet.recordTransaction({ ...base, amount: 200, messageId: 'm1' });
    wallet.recordTransaction({ ...base, amount: 400, messageId: 'm2' });
    expect(wallet.voidTransactionsByMessage('m1')).toHaveLength(2);
    expect(balance('家机A')).toBe(400);
    expect(wallet.voidTransactionsByMessage('m1')).toHaveLength(0);
  });

  it('does not let one user void another user\'s transaction', () => {
    const { transaction } = wallet.recordTransaction({
      from: { external: '公司' },
      to: { account: '家机A' },
      amount: 100,
      reason: 'x',
    });
    const other = new WalletService(db, users.createUser({ name: 'bob' }).id);
    expect(() => other.voidTransaction(transaction.id, 'x')).toThrow(/找不到交易/);
  });

  it('lists newest first, filtered by account', () => {
    wallet.recordTransaction({ from: { external: '公司' }, to: { account: '家机A' }, amount: 1, reason: 'first' });
    wallet.recordTransaction({ from: { external: '公司' }, to: { account: '家机B' }, amount: 2, reason: 'other' });
    wallet.recordTransaction({ from: { external: '公司' }, to: { account: '家机A' }, amount: 3, reason: 'second' });
    expect(wallet.listTransactions({ account: '家机A' }).map((t) => t.reason)).toEqual(['second', 'first']);
    expect(wallet.listTransactions({ limit: 1 })).toHaveLength(1);
  });
});

describe('storage', () => {
  it('rolls back the whole transaction when a nested step fails', () => {
    const before = users.listUsers().length;
    // The player account is created in a nested (savepoint) transaction; an empty name makes it throw.
    expect(() => users.createUser({ name: 'carol', playerName: '  ' })).toThrow(/账户名不能为空/);
    expect(users.listUsers()).toHaveLength(before);
  });

  it('persists to disk and survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentwallet-'));
    try {
      const path = join(dir, 'wallet.db');
      const first = openDb(path);
      const id = new UserService(first).createUser({ name: 'dave' }).id;
      new WalletService(first, id).createAccount({ name: '家机A', initialBalance: 1234 });
      first.$client.close();

      const reopened = openDb(path);
      expect(new WalletService(reopened, id).getAccount('家机A').balance).toBe(1234);
      reopened.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('api keys', () => {
  it('authenticates active keys only', () => {
    const { key, id } = users.createApiKey(wallet.userId, 'test');
    expect(users.authenticate(key)).toBe(wallet.userId);
    expect(users.authenticate(key + 'x')).toBeUndefined();
    expect(users.revokeApiKey(id)).toBe(true);
    expect(users.authenticate(key)).toBeUndefined();
  });
});

describe('sessions', () => {
  it('slides the expiry at most daily and expires after 30 idle days', async () => {
    let now = Date.UTC(2026, 0, 1);
    const clockDb = openDb(':memory:');
    const svc = new UserService(clockDb, () => now);
    svc.createUser({ username: 'neo', password: 'neopass12' });
    const { token, expiresAt } = (await svc.login('neo', 'neopass12'))!;
    expect(expiresAt).toBe(now + SESSION_TTL_MS);

    now += 60 * 60 * 1000; // 1 hour later: valid, no renewal write
    const fresh = svc.resolveSession(token);
    expect(fresh?.user.username).toBe('neo');
    expect(fresh?.renewedUntil).toBeUndefined();

    now += 2 * 24 * 60 * 60 * 1000; // 2 days later: renewed
    expect(svc.resolveSession(token)?.renewedUntil).toBe(now + SESSION_TTL_MS);

    now += SESSION_TTL_MS; // idle for 30 days: expired
    expect(svc.resolveSession(token)).toBeUndefined();
    expect(await svc.login('neo', 'wrong-pass')).toBeUndefined();
  });
});

describe('demo users', () => {
  it('stop working at expiry and are purged with all their data', async () => {
    let now = Date.UTC(2026, 0, 1);
    const clockDb = openDb(':memory:');
    const svc = new UserService(clockDb, () => now);
    const regular = svc.createUser({ username: 'neo', password: 'neopass12' });
    const demo = createDemoUser(clockDb, svc, { ttlMs: 60 * 60 * 1000, now });

    const { token, expiresAt } = svc.createSession(demo);
    expect(expiresAt).toBe(now + 60 * 60 * 1000);
    const { key } = svc.createApiKey(demo.id);
    expect(svc.resolveSession(token)?.user.id).toBe(demo.id);
    expect(svc.authenticate(key)).toBe(demo.id);
    expect(svc.purgeExpiredDemos()).toBe(0);
    expect(svc.countActiveDemos()).toBe(1);

    now += 60 * 60 * 1000;
    expect(svc.resolveSession(token)).toBeUndefined();
    expect(svc.authenticate(key)).toBeUndefined();
    expect(svc.countActiveDemos()).toBe(0);

    expect(svc.purgeExpiredDemos()).toBe(1);
    expect(svc.getUser(demo.id)).toBeUndefined();
    expect(new WalletService(clockDb, demo.id).listAccounts({ includeArchived: true })).toEqual([]);
    expect(svc.listUsers({ includeDemo: true }).map((u) => u.id)).toEqual([regular.id]);
  });
});
