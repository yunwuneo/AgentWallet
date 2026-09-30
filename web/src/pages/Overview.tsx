import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { CreateAgentSheet } from '../components/account-forms';
import { useRecord } from '../components/record';
import { TransactionList } from '../components/transactions';
import { Money, Spinner } from '../components/ui';
import { WalletCard } from '../components/wallets';
import { errorMessage } from '../lib/api';
import { useSummary } from '../lib/queries';

export function Overview() {
  const summary = useSummary();
  const record = useRecord();
  const [creating, setCreating] = useState(false);

  if (summary.isPending) {
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  }
  if (summary.isError) return <div className="form-error">{errorMessage(summary.error)}</div>;

  const { total, month, accounts } = summary.data;
  const player = accounts.find((a) => a.kind === 'player');
  const agents = accounts.filter((a) => a.kind === 'character');

  return (
    <>
      <section>
        <div className="hero-label">总资产</div>
        <Money cents={total} size="xl" />
        <div className="stat-row">
          <span className="stat-pill">
            <ArrowDownLeft size={14} /> 本月收入 <Money cents={month.income} size="md" tone="plain" />
          </span>
          <span className="stat-pill">
            <ArrowUpRight size={14} /> 本月支出 <Money cents={month.expense} size="md" tone="plain" />
          </span>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => record({ mode: 'in' })}>
            <ArrowDownLeft size={18} /> 收入
          </button>
          <button className="btn" onClick={() => record({ mode: 'out' })}>
            <ArrowUpRight size={18} /> 支出
          </button>
          <button className="btn" onClick={() => record({ mode: 'transfer' })}>
            <ArrowLeftRight size={18} /> 转账
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">钱包</h2>
          <span className="subtle">{agents.length} 个 Agent</span>
        </div>
        <div className="wallet-grid">
          {player ? <WalletCard account={player} /> : null}
          {agents.map((a) => (
            <WalletCard key={a.id} account={a} />
          ))}
          <button type="button" className="add-card" onClick={() => setCreating(true)}>
            <Plus size={18} /> 新建 Agent 钱包
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">最近流水</h2>
          <Link to="/transactions" className="subtle" style={{ fontWeight: 600 }}>
            查看全部
          </Link>
        </div>
        <TransactionList limit={8} filters={false} more={false} />
      </section>

      {creating ? <CreateAgentSheet onClose={() => setCreating(false)} /> : null}
    </>
  );
}
