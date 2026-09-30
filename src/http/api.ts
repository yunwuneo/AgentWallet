import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import * as z from 'zod';
import type { Db } from '../db/client.js';
import type { User } from '../db/schema.js';
import { WalletError, type WalletErrorCode } from '../core/errors.js';
import type { WalletEvents } from '../core/events.js';
import { parseMoney } from '../core/money.js';
import { toPublicUser, UserService } from '../core/users.js';
import { WalletService, type AccountWithBalance, type TransactionWithParties } from '../core/wallet.js';

export const SESSION_COOKIE = 'aw_session';

type Env = { Variables: { user: User; sessionToken: string } };

const STATUS: Record<WalletErrorCode, 400 | 401 | 403 | 404 | 409 | 422> = {
  INVALID_AMOUNT: 400,
  INVALID_INPUT: 400,
  INVALID_CREDENTIALS: 400,
  ACCOUNT_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  ACCOUNT_NAME_TAKEN: 409,
  USERNAME_TAKEN: 409,
  ALREADY_VOIDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ACCOUNT_ARCHIVED: 422,
  INSUFFICIENT_FUNDS: 422,
  FORBIDDEN: 403,
};

// ------------------------------------------------------------------ schemas

const money = z.union([z.number(), z.string()]);
const party = z.union([
  z.object({ accountId: z.string().min(1) }).strict(),
  z.object({ external: z.string() }).strict(),
]);
const role = z.enum(['admin', 'user']);

const schemas = {
  login: z.object({ username: z.string(), password: z.string() }),
  changePassword: z.object({ current: z.string(), next: z.string() }),
  createAccount: z.object({ name: z.string(), initialBalance: money.optional(), overdraftLimit: money.optional() }),
  updateAccount: z.object({ name: z.string().optional(), overdraftLimit: money.optional() }),
  createTransaction: z.object({ from: party, to: party, amount: money, reason: z.string() }),
  voidTransaction: z.object({ reason: z.string() }),
  createKey: z.object({ label: z.string().optional() }),
  createUser: z.object({
    username: z.string(),
    password: z.string(),
    name: z.string().optional(),
    role: role.optional(),
    playerName: z.string().optional(),
  }),
  updateUser: z.object({
    name: z.string().optional(),
    username: z.string().optional(),
    role: role.optional(),
    disabled: z.boolean().optional(),
  }),
  resetPassword: z.object({ password: z.string() }),
  transactionQuery: z.object({
    account: z.string().optional(),
    direction: z.enum(['in', 'out', 'internal']).optional(),
    status: z.enum(['active', 'voided', 'all']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WalletError('INVALID_INPUT', '请求体不是有效的 JSON。');
  }
  return validate(schema, raw);
}

function validate<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
    throw new WalletError('INVALID_INPUT', `请求参数无效：${detail}`);
  }
  return parsed.data;
}

// --------------------------------------------------------------- presenters

function presentAccount(a: AccountWithBalance) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    balance: a.balance,
    available: a.available,
    overdraftLimit: a.overdraftLimit,
    createdAt: a.createdAt,
    archivedAt: a.archivedAt,
  };
}

function presentTransaction(t: TransactionWithParties) {
  return {
    id: t.id,
    type: t.type,
    from: t.from,
    to: t.to,
    amount: t.amount,
    reason: t.reason,
    status: t.status,
    messageId: t.messageId,
    createdAt: t.createdAt,
    voidReason: t.voidReason,
    voidedAt: t.voidedAt,
  };
}

// ------------------------------------------------------------ login limiter

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

/** Counts failed logins per (username, IP) in memory; enough for a single-process deployment. */
class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  isBlocked(key: string, now: number): boolean {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) return false;
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  fail(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) this.failures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else entry.count += 1;
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

function clientIp(c: Context): string {
  const forwarded = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isHttps(c: Context): boolean {
  return c.req.header('X-Forwarded-Proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

function setSessionCookie(c: Context, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    path: '/',
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
  });
}

// --------------------------------------------------------------- the router

export interface ApiDeps {
  db: Db;
  events: WalletEvents;
  /** SSE keep-alive interval; shortened in tests. */
  heartbeatMs?: number;
}

export function createApi({ db, events, heartbeatMs = 25_000 }: ApiDeps): Hono<Env> {
  const users = new UserService(db);
  const limiter = new LoginLimiter();
  const wallet = (c: Context<Env>) => new WalletService(db, c.get('user').id, { events });

  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof WalletError) return c.json({ error: err.code, message: err.message }, STATUS[err.code]);
    console.error(err);
    return c.json({ error: 'INTERNAL', message: '服务器内部错误。' }, 500);
  });

  // CSRF: state-changing requests must come from our own origin.
  api.use(async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('Origin');
      const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host');
      let originHost: string | undefined;
      try {
        originHost = origin ? new URL(origin).host : undefined;
      } catch {
        originHost = undefined;
      }
      if (!originHost || originHost !== host) {
        return c.json({ error: 'FORBIDDEN', message: '请求来源校验失败。' }, 403);
      }
    }
    await next();
  });

  // ------------------------------------------------------------------ auth

  api.post('/auth/login', async (c) => {
    const { username, password } = await readJson(c, schemas.login);
    const key = `${username.trim().toLowerCase()}|${clientIp(c)}`;
    const now = Date.now();
    if (limiter.isBlocked(key, now)) {
      return c.json({ error: 'RATE_LIMITED', message: '登录失败次数过多，请 15 分钟后再试。' }, 429);
    }
    const result = await users.login(username, password);
    if (!result) {
      limiter.fail(key, now);
      return c.json({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误。' }, 401);
    }
    limiter.reset(key);
    setSessionCookie(c, result.token, result.expiresAt);
    return c.json({ user: toPublicUser(result.user) });
  });

  api.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) users.logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  // Everything below requires a session.
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? users.resolveSession(token) : undefined;
    if (!token || !session) {
      if (token) deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ error: 'UNAUTHORIZED', message: '请先登录。' }, 401);
    }
    if (session.renewedUntil) setSessionCookie(c, token, session.renewedUntil);
    c.set('user', session.user);
    c.set('sessionToken', token);
    await next();
  };
  // Hono runs handlers in registration order, so the auth routes above respond before this runs.
  api.use('*', requireSession);

  api.get('/me', (c) => c.json({ user: toPublicUser(c.get('user')) }));

  api.post('/me/password', async (c) => {
    const { current, next } = await readJson(c, schemas.changePassword);
    await users.changeOwnPassword(c.get('user').id, current, next, c.get('sessionToken'));
    return c.body(null, 204);
  });

  // --------------------------------------------------------------- wallets

  api.get('/summary', (c) => {
    const s = wallet(c).getSummary();
    return c.json({ total: s.total, month: s.month, accounts: s.accounts.map(presentAccount) });
  });

  api.get('/accounts', (c) => {
    const includeArchived = c.req.query('include_archived') === '1';
    return c.json({ accounts: wallet(c).listAccounts({ includeArchived }).map(presentAccount) });
  });

  api.post('/accounts', async (c) => {
    const body = await readJson(c, schemas.createAccount);
    const account = wallet(c).createAccount({
      name: body.name,
      initialBalance:
        body.initialBalance === undefined || body.initialBalance === ''
          ? 0
          : parseMoney(body.initialBalance, { allowZero: true, allowNegative: true }),
      overdraftLimit:
        body.overdraftLimit === undefined || body.overdraftLimit === ''
          ? 0
          : parseMoney(body.overdraftLimit, { allowZero: true }),
    });
    return c.json({ account: presentAccount(account) }, 201);
  });

  api.get('/accounts/:id', (c) => c.json({ account: presentAccount(wallet(c).getAccountById(c.req.param('id'))) }));

  api.patch('/accounts/:id', async (c) => {
    const body = await readJson(c, schemas.updateAccount);
    const account = wallet(c).updateAccount(
      { id: c.req.param('id') },
      {
        newName: body.name,
        overdraftLimit:
          body.overdraftLimit === undefined ? undefined : parseMoney(body.overdraftLimit, { allowZero: true }),
      },
    );
    return c.json({ account: presentAccount(account) });
  });

  api.post('/accounts/:id/archive', (c) =>
    c.json({ account: presentAccount(wallet(c).archiveAccount({ id: c.req.param('id') })) }),
  );

  // ---------------------------------------------------------- transactions

  api.get('/transactions', (c) => {
    const q = validate(schemas.transactionQuery, c.req.query());
    const page = wallet(c).queryTransactions({ ...q, account: q.account ? { id: q.account } : undefined });
    return c.json({ items: page.items.map(presentTransaction), nextCursor: page.nextCursor ?? null });
  });

  api.post('/transactions', async (c) => {
    const body = await readJson(c, schemas.createTransaction);
    const { transaction } = wallet(c).recordTransaction({
      from: body.from,
      to: body.to,
      amount: parseMoney(body.amount),
      reason: body.reason,
    });
    return c.json({ transaction: presentTransaction(transaction) }, 201);
  });

  api.post('/transactions/:id/void', async (c) => {
    const { reason } = await readJson(c, schemas.voidTransaction);
    return c.json({ transaction: presentTransaction(wallet(c).voidTransaction(c.req.param('id'), reason)) });
  });

  // -------------------------------------------------------------- api keys

  api.get('/keys', (c) => c.json({ keys: users.listApiKeys(c.get('user').id) }));

  api.post('/keys', async (c) => {
    const { label } = await readJson(c, schemas.createKey);
    return c.json(users.createApiKey(c.get('user').id, label), 201);
  });

  api.delete('/keys/:id', (c) => {
    if (!users.revokeApiKey(c.req.param('id'), c.get('user').id)) {
      return c.json({ error: 'NOT_FOUND', message: '找不到该 API Key，或已被吊销。' }, 404);
    }
    return c.body(null, 204);
  });

  // ---------------------------------------------------------- live updates

  api.get('/events', (c) => {
    c.header('X-Accel-Buffering', 'no'); // keep nginx from buffering the stream
    c.header('Cache-Control', 'no-cache');
    const userId = c.get('user').id;
    return streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe(userId, (change) => {
        void stream.writeSSE({ event: 'change', data: JSON.stringify({ scope: change.scope }) }).catch(() => {});
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(heartbeatMs);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {});
      }
      unsubscribe();
    });
  });

  // ----------------------------------------------------------------- admin

  const admin = new Hono<Env>();
  admin.use(async (c, next) => {
    if (c.get('user').role !== 'admin') return c.json({ error: 'FORBIDDEN', message: '需要管理员权限。' }, 403);
    await next();
  });

  admin.get('/users', (c) => c.json({ users: users.listUsers().map(toPublicUser) }));

  admin.post('/users', async (c) => {
    const body = await readJson(c, schemas.createUser);
    const user = users.createUser({
      username: body.username,
      password: body.password,
      name: body.name?.trim() ? body.name : undefined,
      role: body.role,
      playerName: body.playerName?.trim() ? body.playerName : undefined,
    });
    return c.json({ user: toPublicUser(user) }, 201);
  });

  admin.patch('/users/:id', async (c) => {
    const body = await readJson(c, schemas.updateUser);
    return c.json({ user: toPublicUser(users.updateUser(c.get('user').id, c.req.param('id'), body)) });
  });

  admin.post('/users/:id/password', async (c) => {
    const { password } = await readJson(c, schemas.resetPassword);
    users.setPassword(c.req.param('id'), password);
    return c.body(null, 204);
  });

  api.route('/admin', admin);

  // Unknown /api paths must not fall through to the web console's SPA fallback.
  api.all('*', (c) => c.json({ error: 'NOT_FOUND', message: '接口不存在。' }, 404));

  return api;
}

