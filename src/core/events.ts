import { EventEmitter } from 'node:events';

export interface WalletChange {
  userId: string;
  /** What changed, so listeners can refresh selectively. */
  scope: 'accounts' | 'transactions';
}

/** In-process pub/sub for wallet changes, used to push live updates to the web console over SSE. */
export class WalletEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  emit(change: WalletChange): void {
    this.emitter.emit(change.userId, change);
  }

  /** Subscribes to one user's changes; returns an unsubscribe function. */
  subscribe(userId: string, listener: (change: WalletChange) => void): () => void {
    this.emitter.on(userId, listener);
    return () => this.emitter.off(userId, listener);
  }
}
