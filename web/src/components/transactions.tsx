import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ReceiptText, Sparkles } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { errorMessage, type Transaction } from '../lib/api';
import { dayLabel, flowOf, formatDateTime, formatTime, type Flow } from '../lib/format';
import { useTransactions, useVoidTransaction, type TxFilter } from '../lib/queries';
import { Empty, Field, Money, Sheet, Spinner, useToast } from './ui';

type Chip = { key: string; label: string; filter: Pick<TxFilter, 'direction' | 'status'> };

const CHIPS: Chip[] = [
  { key: 'all', label: '全部', filter: {} },
  { key: 'in', label: '收入', filter: { direction: 'in' } },
  { key: 'out', label: '支出', filter: { direction: 'out' } },
  { key: 'internal', label: '转账', filter: { direction: 'internal' } },
  { key: 'voided', label: '已撤销', filter: { status: 'voided' } },
];

/**
 * Transaction list grouped by day, with optional filter chips and "load more".
 * With `accountId`, amounts are signed from that wallet's point of view.
 */
export function TransactionList({
  accountId,
  limit = 20,
  filters = true,
  more = true,
}: {
  accountId?: string;
  limit?: number;
  filters?: boolean;
  more?: boolean;
}) {
  const [chip, setChip] = useState('all');
  const [open, setOpen] = useState<Transaction | null>(null);
  const active = CHIPS.find((c) => c.key === chip) ?? CHIPS[0]!;
  const query = useTransactions({ account: accountId, limit, ...active.filter });

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const groups = useMemo(() => {
    const out: { label: string; items: Transaction[] }[] = [];
    for (const t of items) {
      const label = dayLabel(t.createdAt);
      const last = out.at(-1);
      if (last?.label === label) last.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [items]);

  return (
    <div>
      {filters ? (
        <div className="chips" role="tablist">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={chip === c.key}
              className={`chip ${chip === c.key ? 'on' : ''}`}
              onClick={() => setChip(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}

      {query.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : query.isError ? (
        <div className="form-error">{errorMessage(query.error)}</div>
      ) : items.length === 0 ? (
        <div className="tx-list">
          <Empty icon={<ReceiptText size={22} />}>{chip === 'all' ? '还没有流水' : '没有符合条件的流水'}</Empty>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <div className="tx-group-label">{g.label}</div>
            <div className="tx-list">
              {g.items.map((t) => (
                <TransactionRow key={t.id} tx={t} accountId={accountId} onOpen={() => setOpen(t)} />
              ))}
            </div>
          </section>
        ))
      )}

      {more && query.hasNextPage ? (
        <div className="load-more">
          <button type="button" className="btn ghost sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? <Spinner size={16} /> : '加载更多'}
          </button>
        </div>
      ) : null}

      {open ? <TransactionSheet tx={open} accountId={accountId} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

const FLOW_ICON: Record<Flow, typeof ArrowDownLeft> = {
  in: ArrowDownLeft,
  out: ArrowUpRight,
  internal: ArrowLeftRight,
};

function TxIcon({ tx, flow }: { tx: Transaction; flow: Flow }) {
  const Icon = tx.type === 'opening' ? Sparkles : FLOW_ICON[flow];
  return (
    <span className={`tx-icon ${flow === 'in' ? 'in' : ''}`}>
      <Icon size={18} />
    </span>
  );
}

function signedAmount(tx: Transaction, flow: Flow) {
  if (flow === 'internal') return <Money cents={tx.amount} size="md" tone="plain" />;
  return <Money cents={flow === 'in' ? tx.amount : -tx.amount} size="md" signed tone={flow === 'in' ? 'pos' : 'plain'} />;
}

function TransactionRow({ tx, accountId, onOpen }: { tx: Transaction; accountId?: string; onOpen: () => void }) {
  const flow = flowOf(tx, accountId);
  return (
    <button type="button" className={`tx ${tx.status === 'voided' ? 'voided' : ''}`} onClick={onOpen}>
      <TxIcon tx={tx} flow={flow} />
      <div className="tx-body">
        <div className="tx-title">{tx.reason}</div>
        <div className="tx-sub">
          {tx.from.name} → {tx.to.name} · {formatTime(tx.createdAt)}
        </div>
      </div>
      <div className="tx-amount">
        {signedAmount(tx, flow)}
        {tx.status === 'voided' ? (
          <div>
            <span className="badge warn">已撤销</span>
          </div>
        ) : null}
      </div>
    </button>
  );
}

function PartyLink({ party }: { party: Transaction['from'] }) {
  return party.kind === 'account' ? (
    <Link to={`/accounts/${party.id}`} style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
      {party.name}
    </Link>
  ) : (
    <span>
      {party.name} <span className="subtle">（外部）</span>
    </span>
  );
}

function TransactionSheet({ tx, accountId, onClose }: { tx: Transaction; accountId?: string; onClose: () => void }) {
  const flow = flowOf(tx, accountId);
  const voidTx = useVoidTransaction();
  const toast = useToast();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await voidTx.mutateAsync({ id: tx.id, reason });
      toast('已撤销');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Sheet title="交易详情" onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <TxIcon tx={tx} flow={flow} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650 }}>{tx.reason}</div>
          <div className={tx.status === 'voided' ? 'struck' : ''}>{signedAmount(tx, flow)}</div>
        </div>
      </div>

      <dl className="kv">
        <dt>付款方</dt>
        <dd>
          <PartyLink party={tx.from} />
        </dd>
        <dt>收款方</dt>
        <dd>
          <PartyLink party={tx.to} />
        </dd>
        <dt>时间</dt>
        <dd className="num">{formatDateTime(tx.createdAt)}</dd>
        <dt>状态</dt>
        <dd>{tx.status === 'voided' ? <span className="badge warn">已撤销</span> : <span className="badge">有效</span>}</dd>
        {tx.status === 'voided' ? (
          <>
            <dt>撤销原因</dt>
            <dd>{tx.voidReason}</dd>
            <dt>撤销时间</dt>
            <dd className="num">{tx.voidedAt ? formatDateTime(tx.voidedAt) : '—'}</dd>
          </>
        ) : null}
        {tx.type === 'opening' ? (
          <>
            <dt>类型</dt>
            <dd>开户初始余额</dd>
          </>
        ) : null}
        {tx.messageId ? (
          <>
            <dt>消息 ID</dt>
            <dd className="num">{tx.messageId}</dd>
          </>
        ) : null}
        <dt>交易 ID</dt>
        <dd className="num subtle">{tx.id}</dd>
      </dl>

      {tx.status === 'active' ? (
        voiding ? (
          <form onSubmit={submit}>
            <Field label="撤销原因">
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：剧情回退" required autoFocus />
            </Field>
            {error ? <div className="form-error">{error}</div> : null}
            <div className="sheet-foot">
              <button type="button" className="btn ghost" onClick={() => setVoiding(false)}>
                取消
              </button>
              <button className="btn danger" disabled={voidTx.isPending}>
                {voidTx.isPending ? <Spinner size={18} /> : '确认撤销'}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn danger block" onClick={() => setVoiding(true)}>
            撤销这笔交易
          </button>
        )
      ) : null}
    </Sheet>
  );
}
