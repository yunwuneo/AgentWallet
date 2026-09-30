import { Archive, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { EditAccountSheet } from '../components/account-forms';
import { useRecord } from '../components/record';
import { TransactionList } from '../components/transactions';
import { Avatar, Confirm, Money, Spinner, useToast } from '../components/ui';
import { errorMessage } from '../lib/api';
import { formatDate, kindLabel } from '../lib/format';
import { useAccount, useArchiveAccount } from '../lib/queries';

export function AccountDetail() {
  const { id = '' } = useParams();
  const account = useAccount(id);
  const record = useRecord();
  const archive = useArchiveAccount();
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  if (account.isPending) {
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  }
  if (account.isError) {
    return (
      <>
        <BackLink />
        <div className="form-error">{errorMessage(account.error)}</div>
      </>
    );
  }

  const a = account.data;
  const archived = a.archivedAt !== null;

  async function doArchive() {
    try {
      await archive.mutateAsync(a.id);
      toast(`已归档「${a.name}」`);
      navigate('/');
    } catch (err) {
      toast(errorMessage(err), { error: true });
      setArchiving(false);
    }
  }

  return (
    <>
      <BackLink />
      <div className="detail-head">
        <Avatar name={a.name} size="lg" accent={a.kind === 'player'} />
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title" style={{ overflowWrap: 'anywhere' }}>
            {a.name}
          </h1>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <span className={`badge ${a.kind === 'player' ? 'accent' : ''}`}>{kindLabel(a)}</span>
            {archived ? <span className="badge warn">已归档</span> : null}
          </div>
        </div>
      </div>

      {archived ? (
        <div className="notice">该钱包已于 {formatDate(a.archivedAt!)} 归档，不能再记账，历史流水仍保留。</div>
      ) : null}

      <div className="hero-label">余额</div>
      <Money cents={a.balance} size="xl" />
      <div className="meta-grid">
        <div className="meta">
          <div className="label">可用额度</div>
          <Money cents={a.available} size="md" tone="plain" />
        </div>
        <div className="meta">
          <div className="label">透支额度</div>
          <Money cents={a.overdraftLimit} size="md" tone="plain" />
        </div>
      </div>

      {!archived ? (
        <div className="actions">
          <button className="btn primary" onClick={() => record({ mode: 'in', accountId: a.id })}>
            <ArrowDownLeft size={18} /> 收入
          </button>
          <button className="btn" onClick={() => record({ mode: 'out', accountId: a.id })}>
            <ArrowUpRight size={18} /> 支出
          </button>
          <button className="btn" onClick={() => record({ mode: 'transfer', accountId: a.id })}>
            <ArrowLeftRight size={18} /> 转账
          </button>
          <button className="btn ghost" onClick={() => setEditing(true)}>
            <Pencil size={16} /> 编辑
          </button>
          {a.kind === 'character' ? (
            <button className="btn ghost" onClick={() => setArchiving(true)}>
              <Archive size={16} /> 归档
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">流水</h2>
        </div>
        <TransactionList accountId={a.id} />
      </section>

      {editing ? <EditAccountSheet account={a} onClose={() => setEditing(false)} /> : null}
      {archiving ? (
        <Confirm
          title="归档钱包"
          message={`归档后「${a.name}」不能再记账，历史流水会保留，名称也不能被新钱包复用。确定归档吗？`}
          confirmText="归档"
          danger
          busy={archive.isPending}
          onConfirm={doArchive}
          onClose={() => setArchiving(false)}
        />
      ) : null}
    </>
  );
}

function BackLink() {
  return (
    <Link to="/" className="btn ghost sm" style={{ marginBottom: 20 }}>
      <ArrowLeft size={16} /> 总览
    </Link>
  );
}
