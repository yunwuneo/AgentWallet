// Typed client for the AgentWallet web API (/api). Amounts are integer cents; times are epoch ms.

export type Party = { kind: 'account'; id: string; name: string } | { kind: 'external'; name: string };

export interface Account {
  id: string;
  name: string;
  kind: 'player' | 'character';
  balance: number;
  available: number;
  overdraftLimit: number;
  createdAt: number;
  archivedAt: number | null;
}

export interface Transaction {
  id: string;
  type: 'opening' | 'normal' | 'adjustment';
  from: Party;
  to: Party;
  amount: number;
  reason: string;
  status: 'active' | 'voided';
  messageId: string | null;
  createdAt: number;
  voidReason: string | null;
  voidedAt: number | null;
}

export interface User {
  id: string;
  name: string;
  username: string | null;
  role: 'admin' | 'user';
  createdAt: number;
  disabledAt: number | null;
  hasPassword: boolean;
  /** Set for temporary demo users. */
  demoExpiresAt: number | null;
}

export interface PublicConfig {
  demo: { enabled: boolean; ttlHours: number };
}

export interface ApiKey {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface Summary {
  total: number;
  month: { income: number; expense: number };
  accounts: Account[];
}

export interface TransactionPage {
  items: Transaction[];
  nextCursor: string | null;
}

/** Party as sent when recording: one of the user's wallets or a named outside party. */
export type PartyInput = { accountId: string } | { external: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请稍后重试。');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `HTTP_${res.status}`, data?.message ?? `请求失败（${res.status}）`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '出了点问题，请重试。';
}
