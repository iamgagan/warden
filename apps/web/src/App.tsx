import { useCallback, useEffect, useState } from 'react';
import {
  api,
  dollars,
  UnauthorizedError,
  type Health,
  type Receipt,
  type ReceiptDetail,
  type Stats,
} from './api.js';

const TOKEN_KEY = 'warden_api_token';
const POLL_MS = 5000;

/** One-time token handoff for demos: /#token=... is stored and stripped. */
function tokenFromHash(): string | null {
  const match = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (!match) return null;
  const token = decodeURIComponent(match[1]!);
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState(null, '', window.location.pathname);
  return token;
}

export function App() {
  const [token, setToken] = useState<string | null>(
    () => tokenFromHash() ?? localStorage.getItem(TOKEN_KEY),
  );
  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }
  return (
    <Dashboard
      token={token}
      onUnauthorized={() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }}
    />
  );
}

function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="gate">
      <h1>Warden</h1>
      <p>Enter the API token (WARDEN_API_TOKEN) to open the receipts dashboard.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <input
          autoFocus
          type="password"
          placeholder="API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit">Open dashboard</button>
      </form>
    </main>
  );
}

function Dashboard({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selected, setSelected] = useState<ReceiptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, s, r] = await Promise.all([api.health(), api.stats(token), api.receipts(token)]);
      setHealth(h);
      setStats(s);
      setReceipts(r.receipts);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const openReceipt = async (id: string) => {
    try {
      setSelected(await api.receipt(token, id));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
    }
  };

  return (
    <div className="layout">
      <header>
        <div className="brand">
          <h1>Warden</h1>
          <span className="tagline">every dollar, with the why</span>
        </div>
        <div className="badges">
          {health && <span className={`badge mode-${health.mode}`}>{health.mode} mode</span>}
          {health?.upstream_auth === 'needs_login' && (
            <span className="badge warn">
              upstream auth needed — run <code>warden auth</code>
            </span>
          )}
        </div>
      </header>

      {stats && (
        <section className="stats">
          <Stat label="Receipts" value={String(stats.receipts_total)} />
          <Stat label="Off-policy blocks" value={String(stats.blocks_total)} />
          <Stat label="Spend under management" value={dollars(stats.spend_under_management_cents)} />
          <Stat label="Avg blast radius" value={dollars(stats.avg_blast_radius_cents)} />
        </section>
      )}

      {error && <p className="error">API error: {error}</p>}

      <section className="panel">
        <h2>Receipts</h2>
        {receipts.length === 0 ? (
          <p className="empty">
            No receipts yet. Point your agent at warden-mcp, start a task, and every charge will
            land here bound to its intent.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Merchant</th>
                <th className="num">Amount</th>
                <th>Intent</th>
                <th>Card</th>
                <th>Rail</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} onClick={() => void openReceipt(r.id)}>
                  <td className="mono">{new Date(r.occurred_at).toLocaleString()}</td>
                  <td>{r.agent}</td>
                  <td>{r.merchant}</td>
                  <td className="num">{dollars(r.amount_cents)}</td>
                  <td className="intent">{r.intent}</td>
                  <td className="mono">{r.card_id}</td>
                  <td>
                    <RailBadge rail={r.rail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && <Drawer receipt={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function RailBadge({ rail }: { rail: 'agentcard' | 'stripe' }) {
  return <span className={`rail-badge rail-${rail}`}>{rail === 'agentcard' ? 'AgentCard' : 'Stripe'}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Drawer({ receipt, onClose }: { receipt: ReceiptDetail; onClose: () => void }) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <button className="close" onClick={onClose}>
          ×
        </button>
        <h2>
          {dollars(receipt.amount_cents)} at {receipt.merchant}
        </h2>
        <p className="mono subtle">{new Date(receipt.occurred_at).toLocaleString()}</p>

        <h3>Why this charge happened</h3>
        <blockquote className="intent-full">"{receipt.intent}"</blockquote>
        <p className="subtle">
          Triggering intent captured when agent <strong>{receipt.agent}</strong> started task{' '}
          <span className="mono">{receipt.task_id}</span>.
        </p>

        <h3>Policy decision</h3>
        <p>{receipt.decision_summary}</p>
        <pre>{JSON.stringify(receipt.decision, null, 2)}</pre>

        <h3>Card</h3>
        <p>
          <span className="mono">{receipt.card_id}</span> — single-use, auto-cancelled after this
          authorization. Status: {receipt.transaction_status}. Issued on{' '}
          <RailBadge rail={receipt.rail} /> rail.
        </p>
        {receipt.policy_id && (
          <p className="subtle">
            Policy version <span className="mono">{receipt.policy_id}</span>
          </p>
        )}
      </aside>
    </>
  );
}
