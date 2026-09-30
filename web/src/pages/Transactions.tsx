import { TransactionList } from '../components/transactions';

export function Transactions() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">流水</h1>
      </div>
      <TransactionList />
    </>
  );
}
