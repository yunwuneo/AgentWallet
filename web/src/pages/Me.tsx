import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, KeyRound, LogOut, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, Field, Spinner, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/queries';

export function Me() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const user = me.data;
  if (!user) return null;

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
      </div>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={user.name} size="lg" accent />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{user.name}</div>
          <div className="subtle">
            @{user.username} · {user.role === 'admin' ? '管理员' : '用户'}
          </div>
        </div>
      </div>

      <section className="section">
        <div className="rows">
          <Link to="/keys" className="row">
            <KeyRound size={18} />
            <span className="grow title">API Keys</span>
            <ChevronRight size={18} className="muted" />
          </Link>
          {user.role === 'admin' ? (
            <Link to="/admin/users" className="row">
              <Users size={18} />
              <span className="grow title">用户管理</span>
              <ChevronRight size={18} className="muted" />
            </Link>
          ) : null}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">修改密码</h2>
        </div>
        <ChangePassword />
      </section>

      <section className="section">
        <button className="btn ghost block" onClick={logout}>
          <LogOut size={18} /> 退出登录
        </button>
      </section>
    </>
  );
}

function ChangePassword() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('两次输入的新密码不一致。');
    setBusy(true);
    try {
      await api.post('/me/password', { current, next });
      toast('密码已修改，其他设备已退出登录');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 480 }}>
      <Field label="当前密码">
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="新密码" hint="至少 8 位">
        <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <Field label="确认新密码">
        <input className="input" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      {error ? <div className="form-error">{error}</div> : null}
      <button className="btn primary" disabled={busy}>
        {busy ? <Spinner size={18} /> : '修改密码'}
      </button>
    </form>
  );
}
