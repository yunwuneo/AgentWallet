import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <h1 className="page-title" style={{ marginBottom: 8, color: 'var(--text)' }}>
        页面不存在
      </h1>
      <p style={{ marginBottom: 24 }}>你访问的地址不存在或已被移除。</p>
      <Link to="/" className="btn primary">
        回到总览
      </Link>
    </div>
  );
}
