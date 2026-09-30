import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { apiKeys, users, type User } from '../db/schema.js';
import { WalletError } from './errors.js';
import { newId } from './ids.js';
import { WalletService } from './wallet.js';

export const DEFAULT_PLAYER_NAME = '玩家';

const API_KEY_PREFIX = 'aw_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** User and API-key administration. Not exposed over MCP; used by the admin CLI (and later the web console). */
export class UserService {
  constructor(
    private readonly db: DbHandle,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates a user together with their player account. */
  createUser(input: { name: string; playerName?: string }): User {
    const name = input.name.trim();
    if (!name) throw new WalletError('INVALID_INPUT', '用户名不能为空。');
    return this.db.transaction(
      (tx) => {
        const user: User = { id: newId('usr'), name, createdAt: this.now() };
        tx.insert(users).values(user).run();
        // WalletService opens a nested transaction, which drizzle runs as a savepoint.
        new WalletService(tx, user.id, this.now).createAccount({
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

  /** Issues a new API key. The plaintext key is returned once and only its hash is stored. */
  createApiKey(userId: string, label?: string): { id: string; key: string } {
    if (!this.getUser(userId)) throw new WalletError('INVALID_INPUT', `找不到用户 ${userId}。`);
    const key = API_KEY_PREFIX + randomBytes(24).toString('base64url');
    const id = newId('key');
    this.db
      .insert(apiKeys)
      .values({ id, userId, keyHash: hashApiKey(key), label: label ?? null, createdAt: this.now() })
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

  revokeApiKey(keyId: string): boolean {
    const res = this.db
      .update(apiKeys)
      .set({ revokedAt: this.now() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .run();
    return res.changes > 0;
  }

  /** Returns the user id owning `key`, or undefined if the key is unknown or revoked. */
  authenticate(key: string): string | undefined {
    if (!key.startsWith(API_KEY_PREFIX)) return undefined;
    const row = this.db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
      .get();
    return row?.userId;
  }
}
