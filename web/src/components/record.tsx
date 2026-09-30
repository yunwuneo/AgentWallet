import { createContext, useCallback, useContext, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage, type Account, type PartyInput } from '../lib/api';
import { formatMoney, kindLabel } from '../lib/format';
import { useAccounts, useRecordTransaction } from '../lib/queries';
import { Field, Sheet, Spinner, useToast } from './ui';

export type RecordMode = 'in' | 'out' | 'transfer';

interface RecordRequest {
  mode?: RecordMode;
  /** Preselects this wallet as the receiving (in) or paying (out/transfer) side. */
  accountId?: string;
}

const RecordContext = createContext<(req?: RecordRequest) => void>(() => {});

/** Lets any page open the "记一笔" sheet. */
export const useRecord = () => useContext(RecordContext);

export function RecordProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<RecordRequest | null>(null);
  const open = useCallback((req: RecordRequest = {}) => setRequest(req), []);
  return (
    <RecordContext.Provider value={open}>
      {children}
      {request ? <RecordSheet initial={request} onClose={() => setRequest(null)} /> : null}
    </RecordContext.Provider>
  );
}

const MODES: { value: RecordMode; label: string }[] = [
  { value: 'in', label: '收入' },
  { value: 'out', label: '支出' },
  { value: 'transfer', label: '转账' },
];

function walletOption(a: Account) {
  return `${a.name}（${kindLabel(a)} · ${formatMoney(a.balance)}）`;
}

function RecordSheet({ initial, onClose }: { initial: RecordRequest; onClose: () => void }) {
  const accounts = useAccounts();
  const record = useRecordTransaction();
  const toast = useToast();
  const list = accounts.data ?? [];

  const [mode, setMode] = useState<RecordMode>(initial.mode ?? 'in');
  const [wallet, setWallet] = useState(initial.accountId ?? '');
  const [target, setTarget] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const walletId = wallet || list[0]?.id || '';
  const otherWallets = list.filter((a) => a.id !== walletId);
  const targetId = target && target !== walletId ? target : (otherWallets[0]?.id ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const mine: PartyInput = { accountId: walletId };
    const outside: PartyInput = { external: counterparty };
    const [from, to]: [PartyInput, PartyInput] =
      mode === 'in' ? [outside, mine] : mode === 'out' ? [mine, outside] : [mine, { accountId: targetId }];
    try {
      await record.mutateAsync({ from, to, amount: amount.trim(), reason });
      toast('已记账');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (accounts.isPending) {
    return (
      <Sheet title="记一笔" onClose={onClose}>
        <div className="empty">
          <Spinner />
        </div>
      </Sheet>
    );
  }

  const walletSelect = (value: string, onChange: (v: string) => void, options: Account[]) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} required>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {walletOption(a)}
        </option>
      ))}
    </select>
  );

  return (
    <Sheet title="记一笔" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="segmented" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="tab"
              aria-selected={mode === m.value}
              className={mode === m.value ? 'on' : ''}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <Field label="金额（元）">
          <input
            className="input amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            pattern="\d+(\.\d{1,2})?"
            title="最多两位小数"
            required
            autoFocus
          />
        </Field>

        {mode === 'in' ? (
          <>
            <Field label="收款钱包">{walletSelect(walletId, setWallet, list)}</Field>
            <Field label="付款方" hint="不在系统里的对象，例如公司、兼职、商家">
              <input className="input" placeholder="如：XX公司" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} required />
            </Field>
          </>
        ) : mode === 'out' ? (
          <>
            <Field label="付款钱包">{walletSelect(walletId, setWallet, list)}</Field>
            <Field label="收款方" hint="不在系统里的对象，例如商家、房东">
              <input className="input" placeholder="如：便利店" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} required />
            </Field>
          </>
        ) : (
          <>
            <Field label="从">{walletSelect(walletId, setWallet, list)}</Field>
            <Field label="到">
              {otherWallets.length ? walletSelect(targetId, setTarget, otherWallets) : <p className="subtle">至少需要两个钱包才能转账。</p>}
            </Field>
          </>
        )}

        <Field label="事由">
          <input className="input" placeholder="如：九月工资" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>

        {error ? <div className="form-error">{error}</div> : null}

        <button className="btn primary block" disabled={record.isPending || (mode === 'transfer' && !otherWallets.length)}>
          {record.isPending ? <Spinner size={18} /> : '确认记账'}
        </button>
      </form>
    </Sheet>
  );
}
