import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Confirm, Empty, Field, Sheet, Spinner, useToast } from '../components/ui';
import { api, errorMessage, type ApiKey } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { keys, useApiKeys } from '../lib/queries';

export function Keys() {
  const list = useApiKeys();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });

  async function doRevoke() {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking.id);
      toast('已吊销');
    } catch (err) {
      toast(errorMessage(err), { error: true });
    }
    setRevoking(null);
  }

  const active = list.data?.filter((k) => k.revokedAt === null) ?? [];
  const revoked = list.data?.filter((k) => k.revokedAt !== null) ?? [];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">API Keys</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={18} /> 新建
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 24, maxWidth: 560 }}>
        MCP 客户端（你的聊天程序、Claude Code 等）用 API Key 连接钱包。Key 只在创建时显示一次，请妥善保存。
      </p>

      {list.isPending ? (
        <div className="empty">
          <Spinner />
        </div>
      ) : list.isError ? (
        <div className="form-error">{errorMessage(list.error)}</div>
      ) : (
        <>
          <div className="rows">
            {active.length === 0 ? (
              <Empty icon={<KeyRound size={22} />}>还没有可用的 API Key</Empty>
            ) : (
              active.map((k) => (
                <div className="row" key={k.id}>
                  <div className="grow">
                    <div className="title">{k.label || '未命名'}</div>
                    <div className="subtle num">
                      {k.id} · 创建于 {formatDateTime(k.createdAt)}
                    </div>
                  </div>
                  <button className="btn ghost sm" onClick={() => setRevoking(k)}>
                    吊销
                  </button>
                </div>
              ))
            )}
          </div>

          {revoked.length ? (
            <section className="section">
              <div className="section-head">
                <h2 className="section-title">已吊销</h2>
              </div>
              <div className="rows">
                {revoked.map((k) => (
                  <div className="row" key={k.id} style={{ opacity: 0.6 }}>
                    <div className="grow">
                      <div className="title">{k.label || '未命名'}</div>
                      <div className="subtle num">吊销于 {formatDateTime(k.revokedAt!)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      {creating ? <CreateKeySheet onClose={() => setCreating(false)} /> : null}
      {revoking ? (
        <Confirm
          title="吊销 API Key"
          message={`吊销后，使用「${revoking.label || revoking.id}」的 MCP 客户端将立即无法连接。此操作不可恢复。`}
          confirmText="吊销"
          danger
          busy={revoke.isPending}
          onConfirm={doRevoke}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </>
  );
}

function CreateKeySheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (l: string) => api.post<{ id: string; key: string }>('/keys', { label: l }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      setCreated((await create.mutateAsync(label)).key);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (created) {
    const mcpUrl = `${window.location.origin}/mcp`;
    const command = `claude mcp add --transport http agentwallet ${mcpUrl} --header "Authorization: Bearer ${created}"`;
    return (
      <Sheet title="API Key 已创建" onClose={onClose}>
        <p className="muted" style={{ marginBottom: 16 }}>
          这是唯一一次显示完整 Key，请现在复制保存。
        </p>
        <CopyBox text={created} />
        <Field label="MCP 地址">
          <CopyBox text={mcpUrl} />
        </Field>
        <Field label="Claude Code 接入命令">
          <CopyBox text={command} />
        </Field>
        <button className="btn primary block" onClick={onClose} data-autofocus>
          我已保存
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title="新建 API Key" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="备注" hint="用来区分不同的客户端，例如「聊天程序」「Claude Code」">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="可选" maxLength={64} />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <button className="btn primary block" disabled={create.isPending}>
          {create.isPending ? <Spinner size={18} /> : '创建'}
        </button>
      </form>
    </Sheet>
  );
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('复制失败，请手动选择复制', { error: true });
    }
  }
  return (
    <div className="code-box">
      <code>{text}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label="复制">
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}
