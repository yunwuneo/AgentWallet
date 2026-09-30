import { Link } from 'react-router';
import type { Account } from '../lib/api';
import { kindLabel } from '../lib/format';
import { Avatar, Money } from './ui';

export function WalletCard({ account }: { account: Account }) {
  return (
    <Link to={`/accounts/${account.id}`} className={`wallet-card ${account.kind === 'player' ? 'player' : ''}`}>
      <div className="top">
        <Avatar name={account.name} />
        <div style={{ minWidth: 0 }}>
          <div className="name">{account.name}</div>
          <div className="kind muted">{kindLabel(account)}</div>
        </div>
      </div>
      <div>
        <Money cents={account.balance} size="lg" tone={account.kind === 'player' ? 'plain' : undefined} />
        {account.overdraftLimit > 0 ? (
          <div className="subtle muted" style={{ marginTop: 2 }}>
            可用 <Money cents={account.available} size="md" tone="plain" />
          </div>
        ) : null}
      </div>
    </Link>
  );
}
