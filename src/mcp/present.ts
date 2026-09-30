import { formatCents } from '../core/money.js';
import { formatTime } from '../core/time.js';
import type { AccountWithBalance, Party, TransactionWithParties } from '../core/wallet.js';

// Shapes returned to the model. Amounts are yuan strings ("8000.00"), times are Asia/Shanghai local time.

export function presentAccount(a: AccountWithBalance) {
  return {
    name: a.name,
    kind: a.kind,
    balance: formatCents(a.balance),
    overdraft_limit: formatCents(a.overdraftLimit),
    available: formatCents(a.available),
    ...(a.archivedAt !== null ? { archived_at: formatTime(a.archivedAt) } : {}),
  };
}

function presentParty(p: Party) {
  return p.kind === 'account' ? { account: p.name } : { external: p.name };
}

/** `perspective` is an account id; when given, adds a signed `change` from that account's point of view. */
export function presentTransaction(t: TransactionWithParties, perspective?: string) {
  const change =
    perspective === undefined
      ? undefined
      : t.toAccountId === perspective
        ? `+${formatCents(t.amount)}`
        : `-${formatCents(t.amount)}`;
  return {
    id: t.id,
    time: formatTime(t.createdAt),
    type: t.type,
    from: presentParty(t.from),
    to: presentParty(t.to),
    amount: formatCents(t.amount),
    ...(change !== undefined ? { change } : {}),
    reason: t.reason,
    status: t.status,
    ...(t.messageId ? { message_id: t.messageId } : {}),
    ...(t.status === 'voided'
      ? { void_reason: t.voidReason, voided_at: t.voidedAt === null ? null : formatTime(t.voidedAt) }
      : {}),
  };
}
