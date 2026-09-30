import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// All amounts are integer cents (分). All timestamps are epoch milliseconds (UTC).

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Login name for the web console; null for users that can only use API keys. */
  username: text('username').unique(),
  passwordHash: text('password_hash'),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  createdAt: integer('created_at').notNull(),
  disabledAt: integer('disabled_at'),
  /** Set for temporary demo users; they stop working at this time and are purged afterwards. */
  demoExpiresAt: integer('demo_expires_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the session token; the token itself only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  keyHash: text('key_hash').notNull().unique(),
  label: text('label'),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
});

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['player', 'character'] }).notNull(),
    name: text('name').notNull(),
    overdraftLimit: integer('overdraft_limit').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    uniqueIndex('accounts_user_name_uq').on(t.userId, t.name),
    check('accounts_overdraft_non_negative', sql`${t.overdraftLimit} >= 0`),
  ],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type', { enum: ['opening', 'normal', 'adjustment'] }).notNull(),
    fromAccountId: text('from_account_id').references(() => accounts.id),
    fromExternal: text('from_external'),
    toAccountId: text('to_account_id').references(() => accounts.id),
    toExternal: text('to_external'),
    amount: integer('amount').notNull(),
    reason: text('reason').notNull(),
    messageId: text('message_id'),
    idempotencyKey: text('idempotency_key'),
    status: text('status', { enum: ['active', 'voided'] }).notNull().default('active'),
    voidReason: text('void_reason'),
    voidedAt: integer('voided_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('transactions_user_idem_uq').on(t.userId, t.idempotencyKey),
    index('transactions_from_idx').on(t.fromAccountId, t.status),
    index('transactions_to_idx').on(t.toAccountId, t.status),
    index('transactions_user_created_idx').on(t.userId, t.createdAt),
    index('transactions_user_message_idx').on(t.userId, t.messageId),
    check('transactions_amount_positive', sql`${t.amount} > 0`),
    check(
      'transactions_from_one_side',
      sql`(${t.fromAccountId} IS NULL) <> (${t.fromExternal} IS NULL)`,
    ),
    check('transactions_to_one_side', sql`(${t.toAccountId} IS NULL) <> (${t.toExternal} IS NULL)`),
    check(
      'transactions_has_account',
      sql`${t.fromAccountId} IS NOT NULL OR ${t.toAccountId} IS NOT NULL`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
