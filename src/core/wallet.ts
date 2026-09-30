import { and, desc, eq, getTableColumns, gte, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { accounts, transactions, type Account, type Transaction } from '../db/schema.js';
import { WalletError } from './errors.js';
import type { WalletEvents } from './events.js';
import { newId } from './ids.js';
import { formatCents } from './money.js';
import { startOfMonthShanghai } from './time.js';

type DbOrTx = DbHandle;

/** An account reference: its name (as the MCP tools use) or `{ id }` (as the web API uses). */
export type AccountRef = string | { id: string };

/** A side of a transaction as given by the caller: an account or a free-text external party. */
export type PartyInput = { account: string } | { accountId: string } | { external: string };

export type Party = { kind: 'account'; id: string; name: string } | { kind: 'external'; name: string };

export interface AccountWithBalance extends Account {
  /** Cents. */
  balance: number;
  /** Cents the account can still pay out: balance + overdraftLimit. */
  available: number;
}

export interface TransactionWithParties extends Transaction {
  from: Party;
  to: Party;
}

export interface RecordTransactionInput {
  from: PartyInput;
  to: PartyInput;
  /** Cents, > 0. */
  amount: number;
  reason: string;
  messageId?: string;
  idempotencyKey?: string;
  type?: Transaction['type'];
}

export interface CreateAccountInput {
  name: string;
  kind?: Account['kind'];
  /** Cents; may be negative (starting in debt) down to -overdraftLimit. */
  initialBalance?: number;
  /** Cents, >= 0. */
  overdraftLimit?: number;
}

export interface TransactionQuery {
  account?: AccountRef;
  /**
   * With `account`: relative to that account (in = received, out = paid, internal = with another own wallet).
   * Without: relative to the user (in = from an external party, out = to one, internal = between own wallets).
   */
  direction?: 'in' | 'out' | 'internal';
  status?: 'active' | 'voided' | 'all';
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface WalletSummary {
  /** Cents; sum of all non-archived account balances. */
  total: number;
  accounts: AccountWithBalance[];
  /** Cents received from / paid to external parties this month (Asia/Shanghai), excluding opening balances. */
  month: { income: number; expense: number };
}

export interface WalletServiceOptions {
  now?: () => number;
  /** Receives a change notification after each successful write. */
  events?: WalletEvents;
}

export const OPENING_PARTY = '初始余额';

const NAME_MAX = 64;
const EXTERNAL_MAX = 100;
const REASON_MAX = 500;
const REF_MAX = 200;

type ResolvedParty = { kind: 'account'; account: Account } | { kind: 'external'; name: string };

/** Ledger operations for a single user. Every method is scoped to `userId`; accounts of other users are invisible. */
export class WalletService {
  private readonly now: () => number;
  private readonly events?: WalletEvents;

  constructor(
    private readonly db: DbHandle,
    readonly userId: string,
    opts: WalletServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.events = opts.events;
  }

  // ---------------------------------------------------------------- accounts

  listAccounts(opts: { includeArchived?: boolean } = {}): AccountWithBalance[] {
    const rows = this.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.userId, this.userId), opts.includeArchived ? undefined : isNull(accounts.archivedAt)),
      )
      .orderBy(sql`${accounts.kind} = 'player' desc`, accounts.createdAt)
      .all();
    return rows.map((a) => this.withBalance(this.db, a));
  }

  getAccount(ref: AccountRef, opts: { allowArchived?: boolean } = {}): AccountWithBalance {
    return this.withBalance(this.db, this.resolveAccount(this.db, ref, opts));
  }

  getAccountById(id: string): AccountWithBalance {
    return this.getAccount({ id }, { allowArchived: true });
  }

  createAccount(input: CreateAccountInput): AccountWithBalance {
    const name = cleanText(input.name, '账户名', NAME_MAX);
    const kind = input.kind ?? 'character';
    const overdraftLimit = input.overdraftLimit ?? 0;
    const initialBalance = input.initialBalance ?? 0;
    if (overdraftLimit < 0) throw new WalletError('INVALID_AMOUNT', '透支额度不能为负数。');
    if (initialBalance < -overdraftLimit) {
      throw new WalletError(
        'INSUFFICIENT_FUNDS',
        `初始余额 ${formatCents(initialBalance)} 元低于透支额度允许的下限 -${formatCents(overdraftLimit)} 元。`,
      );
    }

    const result = this.db.transaction(
      (tx) => {
        this.assertNameFree(tx, name);
        if (kind === 'player') {
          const existing = tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.userId, this.userId), eq(accounts.kind, 'player')))
            .get();
          if (existing) throw new WalletError('INVALID_INPUT', '该用户已有玩家账户。');
        }

        const now = this.now();
        const account: Account = {
          id: newId('acc'),
          userId: this.userId,
          kind,
          name,
          overdraftLimit,
          createdAt: now,
          archivedAt: null,
        };
        tx.insert(accounts).values(account).run();

        if (initialBalance !== 0) {
          const incoming = initialBalance > 0;
          tx.insert(transactions)
            .values({
              id: newId('tx'),
              userId: this.userId,
              type: 'opening',
              fromAccountId: incoming ? null : account.id,
              fromExternal: incoming ? OPENING_PARTY : null,
              toAccountId: incoming ? account.id : null,
              toExternal: incoming ? null : OPENING_PARTY,
              amount: Math.abs(initialBalance),
              reason: '开户初始余额',
              createdAt: now,
            })
            .run();
        }
        return this.withBalance(tx, account);
      },
      { behavior: 'immediate' },
    );
    this.notify('accounts');
    return result;
  }

  updateAccount(ref: AccountRef, patch: { newName?: string; overdraftLimit?: number }): AccountWithBalance {
    const result = this.db.transaction(
      (tx) => {
        const account = this.resolveAccount(tx, ref);
        const changes: Partial<Account> = {};
        if (patch.newName !== undefined) {
          const newName = cleanText(patch.newName, '账户名', NAME_MAX);
          if (newName !== account.name) {
            this.assertNameFree(tx, newName);
            changes.name = newName;
          }
        }
        if (patch.overdraftLimit !== undefined) {
          if (patch.overdraftLimit < 0) throw new WalletError('INVALID_AMOUNT', '透支额度不能为负数。');
          changes.overdraftLimit = patch.overdraftLimit;
        }
        if (Object.keys(changes).length === 0) return this.withBalance(tx, account);
        tx.update(accounts).set(changes).where(eq(accounts.id, account.id)).run();
        return this.withBalance(tx, { ...account, ...changes });
      },
      { behavior: 'immediate' },
    );
    this.notify('accounts');
    return result;
  }

  archiveAccount(ref: AccountRef): AccountWithBalance {
    const result = this.db.transaction(
      (tx) => {
        const account = this.resolveAccount(tx, ref);
        if (account.kind === 'player') throw new WalletError('FORBIDDEN', '玩家账户不能归档。');
        const archivedAt = this.now();
        tx.update(accounts).set({ archivedAt }).where(eq(accounts.id, account.id)).run();
        return this.withBalance(tx, { ...account, archivedAt });
      },
      { behavior: 'immediate' },
    );
    this.notify('accounts');
    return result;
  }

  getSummary(): WalletSummary {
    const list = this.listAccounts();
    const monthStart = startOfMonthShanghai(this.now());
    const row = this.db
      .select({
        income: sql<number>`coalesce(sum(case when ${transactions.fromExternal} is not null then ${transactions.amount} else 0 end), 0)`,
        expense: sql<number>`coalesce(sum(case when ${transactions.toExternal} is not null then ${transactions.amount} else 0 end), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, this.userId),
          eq(transactions.status, 'active'),
          ne(transactions.type, 'opening'),
          gte(transactions.createdAt, monthStart),
        ),
      )
      .get();
    return {
      total: list.reduce((sum, a) => sum + a.balance, 0),
      accounts: list,
      month: { income: Number(row?.income ?? 0), expense: Number(row?.expense ?? 0) },
    };
  }

  // ------------------------------------------------------------ transactions

  recordTransaction(input: RecordTransactionInput): { transaction: TransactionWithParties; duplicate: boolean } {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new WalletError('INVALID_AMOUNT', '金额必须大于 0。');
    }
    const reason = cleanText(input.reason, '事由', REASON_MAX);
    const messageId = optionalText(input.messageId, 'message_id', REF_MAX);
    const idempotencyKey = optionalText(input.idempotencyKey, 'idempotency_key', REF_MAX);

    const result = this.db.transaction(
      (tx) => {
        const from = this.resolveParty(tx, input.from, '付款方');
        const to = this.resolveParty(tx, input.to, '收款方');
        if (from.kind === 'external' && to.kind === 'external') {
          throw new WalletError('INVALID_INPUT', '付款方和收款方不能都是外部对象，至少一方必须是钱包账户。');
        }
        if (from.kind === 'account' && to.kind === 'account' && from.account.id === to.account.id) {
          throw new WalletError('INVALID_INPUT', '付款方和收款方不能是同一个账户。');
        }

        if (idempotencyKey) {
          const existing = tx
            .select()
            .from(transactions)
            .where(and(eq(transactions.userId, this.userId), eq(transactions.idempotencyKey, idempotencyKey)))
            .get();
          if (existing) {
            const same =
              existing.amount === input.amount &&
              existing.fromAccountId === partyAccountId(from) &&
              existing.fromExternal === partyExternal(from) &&
              existing.toAccountId === partyAccountId(to) &&
              existing.toExternal === partyExternal(to);
            if (!same) {
              throw new WalletError(
                'IDEMPOTENCY_CONFLICT',
                `idempotency_key "${idempotencyKey}" 已被另一笔不同的交易（${existing.id}）使用。`,
              );
            }
            return { transaction: this.hydrate(tx, existing), duplicate: true };
          }
        }

        if (from.kind === 'account') {
          const { account } = from;
          const balance = this.balanceOf(tx, account.id);
          if (balance - input.amount < -account.overdraftLimit) {
            const available = balance + account.overdraftLimit;
            throw new WalletError(
              'INSUFFICIENT_FUNDS',
              `「${account.name}」余额不足：当前余额 ${formatCents(balance)} 元，透支额度 ${formatCents(account.overdraftLimit)} 元，` +
                `最多还能支出 ${formatCents(Math.max(available, 0))} 元，本次需要 ${formatCents(input.amount)} 元。`,
            );
          }
        }

        const row: Transaction = {
          id: newId('tx'),
          userId: this.userId,
          type: input.type ?? 'normal',
          fromAccountId: partyAccountId(from),
          fromExternal: partyExternal(from),
          toAccountId: partyAccountId(to),
          toExternal: partyExternal(to),
          amount: input.amount,
          reason,
          messageId,
          idempotencyKey,
          status: 'active',
          voidReason: null,
          voidedAt: null,
          createdAt: this.now(),
        };
        tx.insert(transactions).values(row).run();
        return { transaction: this.hydrate(tx, row), duplicate: false };
      },
      { behavior: 'immediate' },
    );
    if (!result.duplicate) this.notify('transactions');
    return result;
  }

  /** Newest-first page of transactions, with a cursor for the next page (undefined on the last page). */
  queryTransactions(q: TransactionQuery = {}): { items: TransactionWithParties[]; nextCursor?: string } {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const accountId = q.account ? this.resolveAccount(this.db, q.account, { allowArchived: true }).id : undefined;
    const conditions: (SQL | undefined)[] = [eq(transactions.userId, this.userId)];

    const status = q.status ?? 'active';
    if (status !== 'all') conditions.push(eq(transactions.status, status));

    if (accountId) {
      conditions.push(or(eq(transactions.fromAccountId, accountId), eq(transactions.toAccountId, accountId)));
      if (q.direction === 'in') conditions.push(eq(transactions.toAccountId, accountId));
      if (q.direction === 'out') conditions.push(eq(transactions.fromAccountId, accountId));
    } else {
      if (q.direction === 'in') conditions.push(isNotNull(transactions.fromExternal));
      if (q.direction === 'out') conditions.push(isNotNull(transactions.toExternal));
    }
    if (q.direction === 'internal') {
      conditions.push(isNotNull(transactions.fromAccountId), isNotNull(transactions.toAccountId));
    }

    if (q.cursor) {
      const [createdAt, rowid] = decodeCursor(q.cursor);
      conditions.push(
        or(
          lt(transactions.createdAt, createdAt),
          and(eq(transactions.createdAt, createdAt), lt(sql`${transactions}.rowid`, rowid)),
        ),
      );
    }

    const rows = this.db
      .select({ ...getTableColumns(transactions), rowid: sql<number>`${transactions}.rowid` })
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.createdAt), desc(sql`${transactions}.rowid`))
      .limit(limit + 1)
      .all();

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const names = this.accountNames(this.db);
    return {
      items: page.map(({ rowid: _rowid, ...r }) => hydrateWith(r, names)),
      nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.rowid}` : undefined,
    };
  }

  listTransactions(opts: { account?: AccountRef; limit?: number; includeVoided?: boolean } = {}): TransactionWithParties[] {
    return this.queryTransactions({
      account: opts.account,
      limit: opts.limit,
      status: opts.includeVoided ? 'all' : 'active',
    }).items;
  }

  voidTransaction(id: string, reason: string): TransactionWithParties {
    const voidReason = cleanText(reason, '撤销原因', REASON_MAX);
    const result = this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, this.userId), eq(transactions.id, id.trim())))
          .get();
        if (!row) throw new WalletError('TRANSACTION_NOT_FOUND', `找不到交易 ${id}。`);
        if (row.status === 'voided') throw new WalletError('ALREADY_VOIDED', `交易 ${id} 已经撤销过了。`);
        const voidedAt = this.now();
        tx.update(transactions)
          .set({ status: 'voided', voidReason, voidedAt })
          .where(eq(transactions.id, row.id))
          .run();
        return this.hydrate(tx, { ...row, status: 'voided', voidReason, voidedAt });
      },
      { behavior: 'immediate' },
    );
    this.notify('transactions');
    return result;
  }

  /** Voids every active transaction recorded with `messageId`, e.g. when the host regenerates that message. */
  voidTransactionsByMessage(messageId: string, reason = '消息已重新生成或删除'): TransactionWithParties[] {
    const mid = cleanText(messageId, 'message_id', REF_MAX);
    const voidReason = cleanText(reason, '撤销原因', REASON_MAX);
    const result = this.db.transaction(
      (tx) => {
        const rows = tx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.userId, this.userId),
              eq(transactions.messageId, mid),
              eq(transactions.status, 'active'),
            ),
          )
          .all();
        if (rows.length === 0) return [];
        const voidedAt = this.now();
        tx.update(transactions)
          .set({ status: 'voided', voidReason, voidedAt })
          .where(
            and(
              eq(transactions.userId, this.userId),
              eq(transactions.messageId, mid),
              eq(transactions.status, 'active'),
            ),
          )
          .run();
        const names = this.accountNames(tx);
        return rows.map((r) => hydrateWith({ ...r, status: 'voided', voidReason, voidedAt }, names));
      },
      { behavior: 'immediate' },
    );
    if (result.length > 0) this.notify('transactions');
    return result;
  }

  // ----------------------------------------------------------------- helpers

  private notify(scope: 'accounts' | 'transactions'): void {
    this.events?.emit({ userId: this.userId, scope });
  }

  private balanceOf(db: DbOrTx, accountId: string): number {
    const row = db
      .select({
        balance: sql<number>`coalesce(sum(case when ${transactions.toAccountId} = ${accountId} then ${transactions.amount} else 0 end), 0)
          - coalesce(sum(case when ${transactions.fromAccountId} = ${accountId} then ${transactions.amount} else 0 end), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'active'),
          or(eq(transactions.toAccountId, accountId), eq(transactions.fromAccountId, accountId)),
        ),
      )
      .get();
    return Number(row?.balance ?? 0);
  }

  private withBalance(db: DbOrTx, account: Account): AccountWithBalance {
    const balance = this.balanceOf(db, account.id);
    return { ...account, balance, available: balance + account.overdraftLimit };
  }

  private resolveAccount(db: DbOrTx, ref: AccountRef, opts: { allowArchived?: boolean } = {}): Account {
    if (typeof ref !== 'string') {
      const account = db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, this.userId), eq(accounts.id, ref.id)))
        .get();
      if (!account) throw new WalletError('ACCOUNT_NOT_FOUND', '找不到该钱包。');
      if (account.archivedAt !== null && !opts.allowArchived) {
        throw new WalletError('ACCOUNT_ARCHIVED', `账户「${account.name}」已归档，不能再使用。`);
      }
      return account;
    }

    const wanted = ref.trim();
    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, this.userId), eq(accounts.name, wanted)))
      .get();
    if (!account) {
      const available = db
        .select({ name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.userId, this.userId), isNull(accounts.archivedAt)))
        .orderBy(accounts.createdAt)
        .all()
        .map((a) => `「${a.name}」`)
        .join('、');
      throw new WalletError(
        'ACCOUNT_NOT_FOUND',
        `找不到账户「${wanted}」。可用账户：${available || '（无）'}。如果对方不是钱包账户，请改用 external 表示外部对象。`,
      );
    }
    if (account.archivedAt !== null && !opts.allowArchived) {
      throw new WalletError('ACCOUNT_ARCHIVED', `账户「${wanted}」已归档，不能再使用。`);
    }
    return account;
  }

  private resolveParty(db: DbOrTx, input: PartyInput, label: string): ResolvedParty {
    if ('account' in input) return { kind: 'account', account: this.resolveAccount(db, input.account) };
    if ('accountId' in input) return { kind: 'account', account: this.resolveAccount(db, { id: input.accountId }) };
    return { kind: 'external', name: cleanText(input.external, `${label}名称`, EXTERNAL_MAX) };
  }

  private assertNameFree(db: DbOrTx, name: string): void {
    const clash = db
      .select({ archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(and(eq(accounts.userId, this.userId), eq(accounts.name, name)))
      .get();
    if (clash) {
      throw new WalletError(
        'ACCOUNT_NAME_TAKEN',
        clash.archivedAt === null ? `账户名「${name}」已存在。` : `账户名「${name}」已被一个已归档的账户占用。`,
      );
    }
  }

  private accountNames(db: DbOrTx): Map<string, string> {
    const rows = db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, this.userId))
      .all();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private hydrate(db: DbOrTx, row: Transaction): TransactionWithParties {
    return hydrateWith(row, this.accountNames(db));
  }
}

function hydrateWith(row: Transaction, names: Map<string, string>): TransactionWithParties {
  const side = (accountId: string | null, external: string | null): Party =>
    accountId ? { kind: 'account', id: accountId, name: names.get(accountId) ?? accountId } : { kind: 'external', name: external ?? '' };
  return { ...row, from: side(row.fromAccountId, row.fromExternal), to: side(row.toAccountId, row.toExternal) };
}

function decodeCursor(cursor: string): [createdAt: number, rowid: number] {
  const m = /^(\d+)\.(\d+)$/.exec(cursor);
  if (!m) throw new WalletError('INVALID_INPUT', '分页游标无效。');
  return [Number(m[1]), Number(m[2])];
}

function partyAccountId(p: ResolvedParty): string | null {
  return p.kind === 'account' ? p.account.id : null;
}

function partyExternal(p: ResolvedParty): string | null {
  return p.kind === 'external' ? p.name : null;
}

function cleanText(value: string, label: string, max: number): string {
  const v = value.trim();
  if (v.length === 0) throw new WalletError('INVALID_INPUT', `${label}不能为空。`);
  if (v.length > max) throw new WalletError('INVALID_INPUT', `${label}过长（最多 ${max} 个字符）。`);
  return v;
}

function optionalText(value: string | undefined, label: string, max: number): string | null {
  if (value === undefined) return null;
  return value.trim() === '' ? null : cleanText(value, label, max);
}
