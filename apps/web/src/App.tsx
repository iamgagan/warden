import { useCallback, useEffect, useState } from 'react';
import {
  api,
  dollars,
  UnauthorizedError,
  type AgentSummary,
  type Health,
  type PolicyRules,
  type PolicyVersion,
  type Receipt,
  type ReceiptDetail,
  type Stats,
} from './api.js';

const DEFAULT_RULES: PolicyRules = {
  allowed_merchants: [],
  blocked_merchants: [],
  allowed_categories: [],
  per_card_cap_cents: 5000,
  per_task_budget_cents: 10_000,
  per_merchant_caps: {},
  velocity: { max_cards_per_hour: 0, max_amount_cents_per_day: 0 },
  approval_threshold_cents: 0,
  card_ttl_minutes: 60,
  default_rail: 'agentcard',
};

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
  const [view, setView] = useState<'receipts' | 'policy'>('receipts');
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

      <nav className="tabs">
        <button className={view === 'receipts' ? 'active' : ''} onClick={() => setView('receipts')}>
          Receipts
        </button>
        <button className={view === 'policy' ? 'active' : ''} onClick={() => setView('policy')}>
          Policy
        </button>
      </nav>

      {view === 'receipts' ? (
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
      ) : (
        <PolicyEditor token={token} onUnauthorized={onUnauthorized} />
      )}

      {selected && <Drawer receipt={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PolicyEditor({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null); // null = global default
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [rules, setRules] = useState<PolicyRules>(DEFAULT_RULES);
  const [merchantCaps, setMerchantCaps] = useState<Array<{ merchant: string; dollars: string }>>([]);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>(
    { kind: 'idle' },
  );

  const loadAgents = useCallback(async () => {
    try {
      setAgents((await api.agents(token)).agents);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
    }
  }, [token, onUnauthorized]);

  const loadPolicy = useCallback(
    async (name: string | null) => {
      try {
        const res = await api.policies(token, name);
        setVersions(res.versions);
        const active = res.active?.rules ?? DEFAULT_RULES;
        setRules(active);
        setMerchantCaps(
          Object.entries(active.per_merchant_caps).map(([merchant, cents]) => ({
            merchant,
            dollars: (cents / 100).toFixed(2),
          })),
        );
        setStatus({ kind: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorized();
      }
    },
    [token, onUnauthorized],
  );

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  useEffect(() => {
    void loadPolicy(agentName);
  }, [agentName, loadPolicy]);

  const save = async () => {
    setStatus({ kind: 'saving' });
    try {
      const per_merchant_caps: Record<string, number> = {};
      for (const row of merchantCaps) {
        const merchant = row.merchant.trim();
        const cents = Math.round(parseFloat(row.dollars || '0') * 100);
        if (merchant && cents > 0) per_merchant_caps[merchant] = cents;
      }
      const res = await api.putPolicy(token, agentName, { ...rules, per_merchant_caps });
      await loadPolicy(agentName);
      setStatus({ kind: 'saved', message: `saved as version ${res.active?.version}` });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const csv = (list: string[]) => list.join(', ');
  const parseCsv = (value: string) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return (
    <section className="panel policy-editor">
      <div className="policy-header">
        <h2>Policy</h2>
        <select value={agentName ?? ''} onChange={(e) => setAgentName(e.target.value || null)}>
          <option value="">Global default</option>
          {agents.map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <p className="subtle">
        {agentName
          ? `Rules for agent "${agentName}". Falls back to the global default if this agent has none.`
          : 'Global default policy — applies to any agent without its own active policy.'}
      </p>

      <div className="policy-grid">
        <label>
          Allowed merchants <span className="subtle">(empty = allow any)</span>
          <input
            value={csv(rules.allowed_merchants)}
            onChange={(e) => setRules({ ...rules, allowed_merchants: parseCsv(e.target.value) })}
            placeholder="Staples, AWS"
          />
        </label>
        <label>
          Blocked merchants
          <input
            value={csv(rules.blocked_merchants)}
            onChange={(e) => setRules({ ...rules, blocked_merchants: parseCsv(e.target.value) })}
            placeholder="sketchy-gift-cards.example"
          />
        </label>
        <label>
          Allowed categories <span className="subtle">(empty = allow any)</span>
          <input
            value={csv(rules.allowed_categories)}
            onChange={(e) => setRules({ ...rules, allowed_categories: parseCsv(e.target.value) })}
            placeholder="office_supplies, cloud_hosting"
          />
        </label>
        <label>
          Default rail
          <select
            value={rules.default_rail}
            onChange={(e) => setRules({ ...rules, default_rail: e.target.value as 'agentcard' | 'stripe' })}
          >
            <option value="agentcard">AgentCard</option>
            <option value="stripe">Stripe</option>
          </select>
        </label>
        <DollarField
          label="Per-card cap"
          hint="clamped to $1–$50 by the upstream network"
          cents={rules.per_card_cap_cents}
          onChange={(c) => setRules({ ...rules, per_card_cap_cents: c })}
        />
        <DollarField
          label="Per-task budget"
          cents={rules.per_task_budget_cents}
          onChange={(c) => setRules({ ...rules, per_task_budget_cents: c })}
        />
        <DollarField
          label="Approval threshold"
          hint="0 = never require approval"
          cents={rules.approval_threshold_cents}
          onChange={(c) => setRules({ ...rules, approval_threshold_cents: c })}
        />
        <label>
          Card TTL (minutes)
          <input
            type="number"
            min={1}
            value={rules.card_ttl_minutes}
            onChange={(e) =>
              setRules({ ...rules, card_ttl_minutes: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        </label>
        <label>
          Max cards / hour <span className="subtle">(0 = unlimited)</span>
          <input
            type="number"
            min={0}
            value={rules.velocity.max_cards_per_hour}
            onChange={(e) =>
              setRules({
                ...rules,
                velocity: { ...rules.velocity, max_cards_per_hour: Math.max(0, Number(e.target.value) || 0) },
              })
            }
          />
        </label>
        <DollarField
          label="Max spend / day"
          hint="0 = unlimited"
          cents={rules.velocity.max_amount_cents_per_day}
          onChange={(c) => setRules({ ...rules, velocity: { ...rules.velocity, max_amount_cents_per_day: c } })}
        />
      </div>

      <h3>Per-merchant caps</h3>
      <div className="merchant-caps">
        {merchantCaps.map((row, i) => (
          <div className="merchant-cap-row" key={i}>
            <input
              placeholder="Merchant"
              value={row.merchant}
              onChange={(e) =>
                setMerchantCaps(merchantCaps.map((r, idx) => (idx === i ? { ...r, merchant: e.target.value } : r)))
              }
            />
            <input
              placeholder="0.00"
              value={row.dollars}
              onChange={(e) =>
                setMerchantCaps(merchantCaps.map((r, idx) => (idx === i ? { ...r, dollars: e.target.value } : r)))
              }
            />
            <button type="button" onClick={() => setMerchantCaps(merchantCaps.filter((_, idx) => idx !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setMerchantCaps([...merchantCaps, { merchant: '', dollars: '' }])}>
          + add merchant cap
        </button>
      </div>

      <div className="policy-actions">
        <button className="save" onClick={() => void save()} disabled={status.kind === 'saving'}>
          {status.kind === 'saving' ? 'Saving…' : 'Save policy'}
        </button>
        {status.kind === 'saved' && <span className="saved-msg">✓ {status.message}</span>}
        {status.kind === 'error' && <span className="error">Failed: {status.message}</span>}
      </div>

      {versions.length > 0 && (
        <>
          <h3>Version history</h3>
          <table className="version-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.version}</td>
                  <td>
                    {v.active ? (
                      <span className="rail-badge rail-agentcard">active</span>
                    ) : (
                      <span className="subtle">superseded</span>
                    )}
                  </td>
                  <td className="mono">{new Date(v.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function DollarField({
  label,
  cents,
  onChange,
  hint,
}: {
  label: string;
  cents: number;
  onChange: (cents: number) => void;
  hint?: string;
}) {
  return (
    <label>
      {label} {hint && <span className="subtle">({hint})</span>}
      <input
        type="number"
        min={0}
        step="0.01"
        value={(cents / 100).toFixed(2)}
        onChange={(e) => onChange(Math.max(0, Math.round((Number(e.target.value) || 0) * 100)))}
      />
    </label>
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
