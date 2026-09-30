export type WalletErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_INPUT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NAME_TAKEN'
  | 'ACCOUNT_ARCHIVED'
  | 'INSUFFICIENT_FUNDS'
  | 'TRANSACTION_NOT_FOUND'
  | 'ALREADY_VOIDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FORBIDDEN'
  | 'USER_NOT_FOUND'
  | 'USERNAME_TAKEN'
  | 'INVALID_CREDENTIALS';

/** A business-rule failure. `message` is user/model facing (Chinese) and should say how to recover. */
export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
