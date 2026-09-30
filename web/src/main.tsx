import '@fontsource-variable/inter';
import './styles.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { RequireAuth } from './components/layout';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { keys } from './lib/queries';
import { AccountDetail } from './pages/AccountDetail';
import { AdminUsers } from './pages/AdminUsers';
import { Keys } from './pages/Keys';
import { Login } from './pages/Login';
import { Me } from './pages/Me';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { Transactions } from './pages/Transactions';

// A 401 anywhere means the session ended: refetch /me, which sends the guard to /login.
const onUnauthorized = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401) void queryClient.invalidateQueries({ queryKey: keys.me });
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => query.queryKey[0] !== 'me' && onUnauthorized(err) }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth />}>
              <Route index element={<Overview />} />
              <Route path="accounts/:id" element={<AccountDetail />} />
              <Route path="transactions" element={<Transactions />} />
              <Route path="keys" element={<Keys />} />
              <Route path="me" element={<Me />} />
              <Route path="admin/users" element={<AdminUsers />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
