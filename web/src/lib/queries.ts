import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Account,
  type ApiKey,
  type PartyInput,
  type Summary,
  type Transaction,
  type TransactionPage,
  type User,
} from './api';

// Everything wallet-related lives under ['wallet', ...] so one invalidation refreshes it all.
export const keys = {
  me: ['me'] as const,
  wallet: ['wallet'] as const,
  summary: ['wallet', 'summary'] as const,
  accounts: (includeArchived: boolean) => ['wallet', 'accounts', includeArchived] as const,
  account: (id: string) => ['wallet', 'account', id] as const,
  transactions: (filter: TxFilter) => ['wallet', 'transactions', filter] as const,
  apiKeys: ['keys'] as const,
  users: ['admin', 'users'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<{ user: User }>('/me').then((r) => r.user),
    staleTime: 5 * 60_000,
  });
}

export function useSummary() {
  return useQuery({ queryKey: keys.summary, queryFn: () => api.get<Summary>('/summary') });
}

export function useAccounts(includeArchived = false) {
  return useQuery({
    queryKey: keys.accounts(includeArchived),
    queryFn: () =>
      api.get<{ accounts: Account[] }>(`/accounts${includeArchived ? '?include_archived=1' : ''}`).then((r) => r.accounts),
  });
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: keys.account(id),
    queryFn: () => api.get<{ account: Account }>(`/accounts/${encodeURIComponent(id)}`).then((r) => r.account),
  });
}

export interface TxFilter {
  account?: string;
  direction?: 'in' | 'out' | 'internal';
  status?: 'active' | 'voided' | 'all';
  limit?: number;
}

export function useTransactions(filter: TxFilter) {
  return useInfiniteQuery({
    queryKey: keys.transactions(filter),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v !== undefined) qs.set(k, String(v));
      if (pageParam) qs.set('cursor', pageParam);
      return api.get<TransactionPage>(`/transactions?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Invalidates all wallet data after a write. */
function useWalletMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.wallet }),
  });
}

export function useRecordTransaction() {
  return useWalletMutation((body: { from: PartyInput; to: PartyInput; amount: string; reason: string }) =>
    api.post<{ transaction: Transaction }>('/transactions', body).then((r) => r.transaction),
  );
}

export function useVoidTransaction() {
  return useWalletMutation(({ id, reason }: { id: string; reason: string }) =>
    api.post<{ transaction: Transaction }>(`/transactions/${id}/void`, { reason }).then((r) => r.transaction),
  );
}

export function useCreateAccount() {
  return useWalletMutation((body: { name: string; initialBalance?: string; overdraftLimit?: string }) =>
    api.post<{ account: Account }>('/accounts', body).then((r) => r.account),
  );
}

export function useUpdateAccount() {
  return useWalletMutation(({ id, ...body }: { id: string; name?: string; overdraftLimit?: string }) =>
    api.patch<{ account: Account }>(`/accounts/${id}`, body).then((r) => r.account),
  );
}

export function useArchiveAccount() {
  return useWalletMutation((id: string) => api.post<{ account: Account }>(`/accounts/${id}/archive`).then((r) => r.account));
}

export function useApiKeys() {
  return useQuery({ queryKey: keys.apiKeys, queryFn: () => api.get<{ keys: ApiKey[] }>('/keys').then((r) => r.keys) });
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => api.get<{ users: User[] }>('/admin/users').then((r) => r.users) });
}
