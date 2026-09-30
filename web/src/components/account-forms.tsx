import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage, type Account } from '../lib/api';
import { centsToInput } from '../lib/format';
import { useCreateAccount, useUpdateAccount } from '../lib/queries';
import { Field, Sheet, Spinner, useToast } from './ui';

const MONEY_PATTERN = '-?\\d+(\\.\\d{1,2})?';

export function CreateAgentSheet({ onClose }: { onClose: () => void }) {
  const create = useCreateAccount();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [initialBalance, setInitialBalance] = useState('');
  const [overdraftLimit, setOverdraftLimit] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const account = await create.mutateAsync({ name, initialBalance, overdraftLimit });
      toast(`已创建「${account.name}」`);
      onClose();
      navigate(`/accounts/${account.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Sheet title="新建 Agent 钱包" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="名称" hint="MCP 记账时用这个名字引用钱包，同一用户下唯一">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：家机A" required maxLength={64} />
        </Field>
        <Field label="初始余额（元）" hint="可留空，默认 0">
          <input className="input num" inputMode="decimal" pattern={MONEY_PATTERN} value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="透支额度（元）" hint="最多可以欠多少钱，0 表示不能透支">
          <input className="input num" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={overdraftLimit} onChange={(e) => setOverdraftLimit(e.target.value)} placeholder="0.00" />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={create.isPending}>
          {create.isPending ? <Spinner size={18} /> : '创建'}
        </button>
      </form>
    </Sheet>
  );
}

export function EditAccountSheet({ account, onClose }: { account: Account; onClose: () => void }) {
  const update = useUpdateAccount();
  const toast = useToast();
  const [name, setName] = useState(account.name);
  const [overdraftLimit, setOverdraftLimit] = useState(centsToInput(account.overdraftLimit));
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ id: account.id, name, overdraftLimit: overdraftLimit.trim() || '0' });
      toast('已保存');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Sheet title="编辑钱包" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="名称" hint="改名后，MCP 需用新名字引用该钱包">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
        </Field>
        <Field label="透支额度（元）" hint="0 表示不能透支">
          <input className="input num" inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={overdraftLimit} onChange={(e) => setOverdraftLimit(e.target.value)} />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={update.isPending}>
          {update.isPending ? <Spinner size={18} /> : '保存'}
        </button>
      </form>
    </Sheet>
  );
}
