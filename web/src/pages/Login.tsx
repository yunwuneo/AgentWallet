import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Field, Spinner } from '../components/ui';
import { api, errorMessage, type User } from '../lib/api';
import { keys, usePublicConfig } from '../lib/queries';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const config = usePublicConfig();
  const demo = config.data?.demo;

  async function startDemo() {
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/auth/demo');
      qc.setQueryData(keys.me, user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/auth/login', { username, password });
      qc.setQueryData(keys.me, user);
      const next = params.get('next');
      navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">
            <Wallet size={18} />
          </span>
          AgentWallet
        </div>
        <h1 className="login-title">欢迎回来</h1>
        <p className="muted" style={{ marginBottom: 28 }}>
          登录以管理你和 Agent 的钱包。
        </p>
        <Field label="用户名">
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </Field>
        <Field label="密码">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={busy} style={{ marginTop: 8, height: 50 }}>
          {busy ? <Spinner size={18} /> : '登录'}
        </button>
        {demo?.enabled ? (
          <>
            <div className="divider">或</div>
            <button type="button" className="btn ghost block" disabled={busy} onClick={startDemo} style={{ height: 50 }}>
              <Sparkles size={18} /> 体验演示
            </button>
            <p className="subtle" style={{ textAlign: 'center', marginTop: 10 }}>
              无需注册，预置示例钱包和流水，{demo.ttlHours} 小时后自动清除
            </p>
          </>
        ) : null}
      </form>
    </div>
  );
}
