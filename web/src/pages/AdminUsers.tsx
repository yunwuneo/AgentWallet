import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Avatar, Confirm, Empty, Field, Sheet, Spinner, useToast } from '../components/ui';
import { api, errorMessage, type User } from '../lib/api';
import { formatDate } from '../lib/format';
import { keys, useMe, useUsers } from '../lib/queries';

type Action = { kind: 'password'; user: User } | { kind: 'disable' | 'enable' | 'promote' | 'demote'; user: User };

export function AdminUsers() {
  const me = useMe();
  const list = useUsers();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ role: User['role']; disabled: boolean }> }) =>
      api.patch<{ user: User }>(`/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.users }),
  });

  async function applyAction() {
    if (!action || action.kind === 'password') return;
    const body =
      action.kind === 'disable'
        ? { disabled: true }
        : action.kind === 'enable'
          ? { disabled: false }
          : { role: action.kind === 'promote' ? ('admin' as const) : ('user' as const) };
    try {
      await patch.mutateAsync({ id: action.user.id, body });
      toast('已更新');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
    setAction(null);
  }

  const confirmCopy: Record<Exclude<Action['kind'], 'password'>, { title: string; text: (u: User) => string; button: string; danger?: boolean }> = {
    disable: { title: '停用用户', text: (u) => `停用后「${u.name}」将立即退出登录，其 API Key 也会失效。钱包数据保留。`, button: '停用', danger: true },
    enable: { title: '启用用户', text: (u) => `恢复「${u.name}」的登录和 API Key 访问。`, button: '启用' },
    promote: { title: '设为管理员', text: (u) => `「${u.name}」将可以管理所有用户账号（但不能查看他人钱包）。`, button: '设为管理员' },
    demote: { title: '取消管理员', text: (u) => `「${u.name}」将失去用户管理权限。`, button: '取消管理员', danger: true },
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">用户管理</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={18} /> 新建用户
        </button>
      </div>

      {list.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : list.isError ? (
        <div className="form-error">{errorMessage(list.error)}</div>
      ) : list.data.length === 0 ? (
        <Empty icon={<Users size={22} />}>还没有用户</Empty>
      ) : (
        <div className="rows">
          {list.data.map((u) => {
            const self = u.id === me.data?.id;
            const disabled = u.disabledAt !== null;
            return (
              <div className="row" key={u.id} style={disabled ? { opacity: 0.65 } : undefined}>
                <Avatar name={u.name} accent={u.role === 'admin'} />
                <div className="grow">
                  <div className="title">
                    {u.name}
                    {u.role === 'admin' ? <span className="badge accent">管理员</span> : null}
                    {disabled ? <span className="badge warn">已停用</span> : null}
                    {self ? <span className="badge">我</span> : null}
                  </div>
                  <div className="subtle">
                    {u.username ? `@${u.username}` : '未设置登录名'}
                    {!u.hasPassword ? ' · 未设置密码' : ''} · 创建于 {formatDate(u.createdAt)}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn ghost sm" onClick={() => setAction({ kind: 'password', user: u })}>
                    {u.username && u.hasPassword ? '重置密码' : '设置登录'}
                  </button>
                  {!self ? (
                    <>
                      <button className="btn ghost sm" onClick={() => setAction({ kind: u.role === 'admin' ? 'demote' : 'promote', user: u })}>
                        {u.role === 'admin' ? '取消管理员' : '设为管理员'}
                      </button>
                      <button className="btn ghost sm" onClick={() => setAction({ kind: disabled ? 'enable' : 'disable', user: u })}>
                        {disabled ? '启用' : '停用'}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating ? <CreateUserSheet onClose={() => setCreating(false)} /> : null}
      {action?.kind === 'password' ? <PasswordSheet user={action.user} onClose={() => setAction(null)} /> : null}
      {action && action.kind !== 'password' ? (
        <Confirm
          title={confirmCopy[action.kind].title}
          message={confirmCopy[action.kind].text(action.user)}
          confirmText={confirmCopy[action.kind].button}
          danger={confirmCopy[action.kind].danger}
          busy={patch.isPending}
          onConfirm={applyAction}
          onClose={() => setAction(null)}
        />
      ) : null}
    </>
  );
}

function CreateUserSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ username: '', name: '', password: '', playerName: '', admin: false });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: User }>('/admin/users', {
        username: form.username,
        name: form.name,
        password: form.password,
        playerName: form.playerName,
        role: form.admin ? 'admin' : 'user',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.users }),
  });
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { user } = await create.mutateAsync();
      toast(`已创建用户「${user.name}」`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Sheet title="新建用户" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="登录名" hint="3–32 位字母、数字、_ . -">
          <input className="input" value={form.username} onChange={set('username')} autoComplete="off" pattern="[A-Za-z0-9_.\-]{3,32}" required />
        </Field>
        <Field label="显示名称" hint="可留空，默认与登录名相同">
          <input className="input" value={form.name} onChange={set('name')} maxLength={64} />
        </Field>
        <Field label="初始密码" hint="至少 8 位，请告知用户登录后自行修改">
          <input className="input" type="text" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
        </Field>
        <Field label="「我的钱包」名称" hint="MCP 中引用玩家钱包的名字，默认「玩家」">
          <input className="input" value={form.playerName} onChange={set('playerName')} placeholder="玩家" maxLength={64} />
        </Field>
        <label className="checkbox" style={{ marginBottom: 20 }}>
          <input type="checkbox" checked={form.admin} onChange={set('admin')} /> 设为管理员
        </label>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={create.isPending}>
          {create.isPending ? <Spinner size={18} /> : '创建'}
        </button>
      </form>
    </Sheet>
  );
}

/** Resets the password; for legacy CLI users without a login name, also sets one. */
function PasswordSheet({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(user.username ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (username !== (user.username ?? '')) await api.patch(`/admin/users/${user.id}`, { username });
      await api.post(`/admin/users/${user.id}/password`, { password });
      await qc.invalidateQueries({ queryKey: keys.users });
      toast('已更新登录信息');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={user.username ? `重置「${user.name}」的密码` : `为「${user.name}」设置登录`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="登录名">
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} pattern="[A-Za-z0-9_.\-]{3,32}" required autoComplete="off" />
        </Field>
        <Field label="新密码" hint="至少 8 位。重置后该用户的所有登录会话都会失效">
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete="new-password" />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={busy}>
          {busy ? <Spinner size={18} /> : '保存'}
        </button>
      </form>
    </Sheet>
  );
}
