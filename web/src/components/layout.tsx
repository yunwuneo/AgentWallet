import { useQueryClient } from '@tanstack/react-query';
import { House, KeyRound, LogOut, Plus, ReceiptText, Settings, UserRound, Users, Wallet } from 'lucide-react';
import { useEffect } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, ApiError, type User } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { keys, useMe } from '../lib/queries';
import { RecordProvider, useRecord } from './record';
import { Avatar, Spinner } from './ui';

/** Guards the signed-in area: redirects to /login on 401, otherwise renders the shell. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) {
    return (
      <div className="splash">
        <Spinner size={28} />
      </div>
    );
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      const next = location.pathname === '/' ? '' : `?next=${encodeURIComponent(location.pathname)}`;
      return <Navigate to={`/login${next}`} replace />;
    }
    return (
      <div className="splash">
        <div style={{ textAlign: 'center' }}>
          <p style={{ marginBottom: 16 }}>{me.error.message}</p>
          <button className="btn" onClick={() => me.refetch()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  return (
    <RecordProvider>
      <Shell user={me.data} />
    </RecordProvider>
  );
}

/** Refreshes wallet data when the server pushes a change (e.g. a role-play MCP call recorded money). */
function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries({ queryKey: keys.wallet }), 250);
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [qc]);
}

function Shell({ user }: { user: User }) {
  useLiveUpdates();
  const record = useRecord();
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login', { replace: true });
  }

  const navClass = ({ isActive }: { isActive: boolean }) => `nav-link ${isActive ? 'active' : ''}`;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Wallet size={18} />
          </span>
          AgentWallet
        </div>
        <button className="btn primary" style={{ marginBottom: 12 }} onClick={() => record()}>
          <Plus size={18} /> 记一笔
        </button>
        <NavLink to="/" end className={navClass}>
          <House size={18} /> 总览
        </NavLink>
        <NavLink to="/transactions" className={navClass}>
          <ReceiptText size={18} /> 流水
        </NavLink>
        <NavLink to="/keys" className={navClass}>
          <KeyRound size={18} /> API Keys
        </NavLink>
        {user.role === 'admin' ? (
          <NavLink to="/admin/users" className={navClass}>
            <Users size={18} /> 用户管理
          </NavLink>
        ) : null}
        <NavLink to="/me" className={navClass}>
          <Settings size={18} /> 设置
        </NavLink>
        <div className="sidebar-footer">
          <Avatar name={user.name} />
          <div className="who">
            <strong>{user.name}</strong>
            <span className="subtle">{user.demoExpiresAt ? '演示账号' : `@${user.username}`}</span>
          </div>
          <button className="icon-btn" onClick={logout} title="退出登录" aria-label="退出登录">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <main className="main">
        {user.demoExpiresAt ? (
          <div className="notice demo-banner">
            <strong>演示模式</strong>
            <span>
              这是你的专属演示账号，可随意操作，也可以在 API Keys 页创建 Key 接入 MCP。数据将于{' '}
              <span className="num">{formatDateTime(user.demoExpiresAt).slice(0, 16)}</span> 自动清除。
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <NavLink to="/" end>
          <House size={22} />
          总览
        </NavLink>
        <NavLink to="/transactions">
          <ReceiptText size={22} />
          流水
        </NavLink>
        <button type="button" onClick={() => record()} aria-label="记一笔">
          <span className="fab">
            <Plus size={24} />
          </span>
        </button>
        <NavLink to="/me">
          <UserRound size={22} />
          我的
        </NavLink>
      </nav>
    </div>
  );
}
