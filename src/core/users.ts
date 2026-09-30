import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, isNull, lt, ne } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { apiKeys, sessions, users, type User } from '../db/schema.js';
import { WalletError } from './errors.js';
import { newId } from './ids.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
import { WalletService } from './wallet.js';

export const DEFAULT_PLAYER_NAME = '玩家';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is extended at most this often, to avoid a write on every request. */
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const API_KEY_PREFIX = 'aw_';
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const NAME_MAX = 64;

export type Role = User['role'];

/** A user as exposed outside the service: never includes the password hash. */
export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  role: Role;
  createdAt: number;
  disabledAt: number | null;
  hasPassword: boolean;
}

export interface CreateUserInput {
  name?: string;
  username?: string;
  password?: string;
  role?: Role;
  playerName?: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    disabledAt: u.disabledAt,
    hasPassword: u.passwordHash !== null,
  };
}

/** Users, login credentials, sessions and API keys. Used by the admin CLI and the web API; not exposed over MCP. */
export class UserService {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => number = Date.now,
  ) {}

  // ------------------------------------------------------------------- users

  /** Creates a user together with their player account. */
  createUser(input: CreateUserInput): User {
    const username = input.username === undefined ? null : validateUsername(input.username);
    const passwordHash = input.password === undefined ? null : hashPassword(validatePassword(input.password));
    const name = cleanName(input.name ?? username ?? '');

    return this.db.transaction(
      (tx) => {
        if (username) this.assertUsernameFree(tx, username);
        const user: User = {
          id: newId('usr'),
          name,
          username,
          passwordHash,
          role: input.role ?? 'user',
          createdAt: this.now(),
          disabledAt: null,
        };
        tx.insert(users).values(user).run();
        // WalletService opens a nested transaction, which drizzle runs as a savepoint.
        new WalletService(tx, user.id, { now: this.now }).createAccount({
          name: input.playerName ?? DEFAULT_PLAYER_NAME,
          kind: 'player',
        });
        return user;
      },
      { behavior: 'immediate' },
    );
  }

  listUsers(): User[] {
    return this.db.select().from(users).orderBy(users.createdAt).all();
  }

  getUser(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  requireUser(id: string): User {
    const user = this.getUser(id);
    if (!user) throw new WalletError('USER_NOT_FOUND', '找不到该用户。');
    return user;
  }

  /**
   * Changes a user's profile, login name, role or disabled state on behalf of `actorId`.
   * Admins cannot demote or disable themselves, and at least one active admin always remains.
   */
  updateUser(
    actorId: string,
    targetId: string,
    patch: { name?: string; username?: string; role?: Role; disabled?: boolean },
  ): User {
    return this.db.transaction(
      (tx) => {
        const target = this.requireUser(targetId);
        const changes: Partial<User> = {};
        if (patch.name !== undefined) changes.name = cleanName(patch.name);
        if (patch.username !== undefined) {
          const username = validateUsername(patch.username);
          if (username !== target.username) {
            this.assertUsernameFree(tx, username);
            changes.username = username;
          }
        }
        if (patch.role !== undefined && patch.role !== target.role) {
          if (actorId === targetId) throw new WalletError('FORBIDDEN', '不能修改自己的角色。');
          changes.role = patch.role;
        }
        if (patch.disabled !== undefined && patch.disabled !== (target.disabledAt !== null)) {
          if (actorId === targetId) throw new WalletError('FORBIDDEN', '不能停用自己。');
          changes.disabledAt = patch.disabled ? this.now() : null;
        }

        const losesAdmin =
          target.role === 'admin' && target.disabledAt === null && (changes.role === 'user' || !!changes.disabledAt);
        if (losesAdmin && this.countActiveAdmins(tx, target.id) === 0) {
          throw new WalletError('FORBIDDEN', '至少需要保留一个可用的管理员。');
        }

        if (Object.keys(changes).length > 0) tx.update(users).set(changes).where(eq(users.id, target.id)).run();
        if (changes.disabledAt) tx.delete(sessions).where(eq(sessions.userId, target.id)).run();
        return { ...target, ...changes };
      },
      { behavior: 'immediate' },
    );
  }

  /** Sets a new password and signs the user out everywhere except `keepSessionToken` (if given). */
  setPassword(userId: string, password: string, keepSessionToken?: string): void {
    const passwordHash = hashPassword(validatePassword(password));
    this.db.transaction(
      (tx) => {
        this.requireUser(userId);
        tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
        const keep = keepSessionToken ? hashToken(keepSessionToken) : undefined;
        tx.delete(sessions)
          .where(and(eq(sessions.userId, userId), keep ? ne(sessions.id, keep) : undefined))
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  /** Changes the caller's own password after checking the current one. */
  async changeOwnPassword(userId: string, current: string, next: string, sessionToken: string): Promise<void> {
    const user = this.requireUser(userId);
    if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
      throw new WalletError('INVALID_CREDENTIALS', '当前密码不正确。');
    }
    this.setPassword(userId, next, sessionToken);
  }

  // ---------------------------------------------------------------- sessions

  /** Verifies credentials and opens a session. Returns undefined for wrong credentials or disabled users. */
  async login(username: string, password: string): Promise<{ user: User; token: string; expiresAt: number } | undefined> {
    const user = this.db.select().from(users).where(eq(users.username, username.trim())).get();
    // Always run scrypt so response time does not reveal whether the username exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.passwordHash || !ok || user.disabledAt !== null) return undefined;

    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db.insert(sessions).values({ id: hashToken(token), userId: user.id, createdAt: now, expiresAt }).run();
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run(); // opportunistic cleanup
    return { user, token, expiresAt };
  }

  /**
   * Resolves a session token to its user, extending the expiry when it is more than a day old.
   * `renewedUntil` is set when the expiry moved, so the caller can refresh the cookie.
   */
  resolveSession(token: string): { user: User; renewedUntil?: number } | undefined {
    const id = hashToken(token);
    const row = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id))
      .get();
    if (!row) return undefined;
    const now = this.now();
    if (row.session.expiresAt <= now || row.user.disabledAt !== null) {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      return undefined;
    }
    if (row.session.expiresAt - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
      const renewedUntil = now + SESSION_TTL_MS;
      this.db.update(sessions).set({ expiresAt: renewedUntil }).where(eq(sessions.id, id)).run();
      return { user: row.user, renewedUntil };
    }
    return { user: row.user };
  }

  logout(token: string): void {
    this.db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  }

  // ---------------------------------------------------------------- api keys

  /** Issues a new API key. The plaintext key is returned once and only its hash is stored. */
  createApiKey(userId: string, label?: string): { id: string; key: string } {
    this.requireUser(userId);
    const key = API_KEY_PREFIX + randomBytes(24).toString('base64url');
    const id = newId('key');
    const cleanLabel = label?.trim() ? label.trim().slice(0, NAME_MAX) : null;
    this.db
      .insert(apiKeys)
      .values({ id, userId, keyHash: hashApiKey(key), label: cleanLabel, createdAt: this.now() })
      .run();
    return { id, key };
  }

  listApiKeys(userId: string) {
    return this.db
      .select({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(apiKeys.createdAt)
      .all();
  }

  /** Revokes a key. With `userId`, only that user's keys can be revoked. */
  revokeApiKey(keyId: string, userId?: string): boolean {
    const res = this.db
      .update(apiKeys)
      .set({ revokedAt: this.now() })
      .where(
        and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt), userId ? eq(apiKeys.userId, userId) : undefined),
      )
      .run();
    return Number(res.changes) > 0;
  }

  /** Returns the user id owning `key`, or undefined if the key is unknown, revoked, or its user is disabled. */
  authenticate(key: string): string | undefined {
    if (!key.startsWith(API_KEY_PREFIX)) return undefined;
    const row = this.db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt), isNull(users.disabledAt)))
      .get();
    return row?.userId;
  }

  // ----------------------------------------------------------------- helpers

  private assertUsernameFree(db: DbHandle, username: string): void {
    if (db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()) {
      throw new WalletError('USERNAME_TAKEN', `登录名「${username}」已被使用。`);
    }
  }

  private countActiveAdmins(db: DbHandle, excludingId: string): number {
    const row = db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, excludingId)))
      .get();
    return row?.n ?? 0;
  }
}

function validateUsername(value: string): string {
  const v = value.trim();
  if (!USERNAME_RE.test(v)) {
    throw new WalletError('INVALID_INPUT', '登录名需为 3–32 位字母、数字、下划线、点或短横线。');
  }
  return v;
}

function validatePassword(value: string): string {
  if (value.length < PASSWORD_MIN) throw new WalletError('INVALID_INPUT', `密码至少 ${PASSWORD_MIN} 位。`);
  if (value.length > PASSWORD_MAX) throw new WalletError('INVALID_INPUT', `密码最多 ${PASSWORD_MAX} 位。`);
  return value;
}

function cleanName(value: string): string {
  const v = value.trim();
  if (!v) throw new WalletError('INVALID_INPUT', '用户名称不能为空。');
  if (v.length > NAME_MAX) throw new WalletError('INVALID_INPUT', `用户名称过长（最多 ${NAME_MAX} 个字符）。`);
  return v;
}
