import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  dollars,
  UnauthorizedError,
  type AgentSummary,
  type CreateMandateInput,
  type Evidence,
  type Health,
  type Mandate,
  type PolicyEvent,
  type PolicyRules,
  type PolicyVersion,
  type Receipt,
  type Stats,
} from './api.js';

const TOKEN_KEY = 'warden_api_token';
const POLL_MS = 5000;

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

type View = 'overview' | 'mandates' | 'evidence' | 'policy';
type IconName =
  | 'overview'
  | 'mandate'
  | 'evidence'
  | 'policy'
  | 'plus'
  | 'shield'
  | 'arrow'
  | 'close'
  | 'check'
  | 'clock'
  | 'merchant'
  | 'agent'
  | 'search';

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
        onSubmit={(nextToken) => {
          localStorage.setItem(TOKEN_KEY, nextToken);
          setToken(nextToken);
        }}
      />
    );
  }
  return (
    <ControlPlane
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
    <main className="gate-shell">
      <section className="gate-card">
        <Logo />
        <div className="gate-copy">
          <span className="eyebrow">Operator access</span>
          <h1>Your control plane for agent spend.</h1>
          <p>Enter the local API token to review authority, outcomes, and evidence.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <label htmlFor="api-token">API token</label>
          <div className="gate-input-row">
            <input
              id="api-token"
              autoFocus
              type="password"
              autoComplete="current-password"
              placeholder="Paste your Warden token"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="primary-button">
              Continue <Icon name="arrow" />
            </button>
          </div>
        </form>
        <p className="gate-footnote">The token stays in this browser.</p>
      </section>
      <div className="gate-aside" aria-hidden="true">
        <div className="gate-orbit orbit-one" />
        <div className="gate-orbit orbit-two" />
        <div className="gate-proof">
          <Icon name="shield" />
          <span>Authority before execution</span>
          <strong>Evidence after settlement</strong>
        </div>
      </div>
    </main>
  );
}

function ControlPlane({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const [view, setView] = useState<View>('overview');
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [events, setEvents] = useState<PolicyEvent[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextStats, nextMandates, nextEvidence, nextReceipts, nextEvents] =
        await Promise.all([
          api.health(),
          api.stats(token),
          api.mandates(token),
          api.evidence(token),
          api.receipts(token),
          api.events(token),
        ]);
      setHealth(nextHealth);
      setStats(nextStats);
      setMandates(nextMandates.mandates);
      setEvidence(nextEvidence.evidence);
      setReceipts(nextReceipts.receipts);
      setEvents(nextEvents.events);
      setError(null);
    } catch (nextError) {
      if (nextError instanceof UnauthorizedError) onUnauthorized();
      else setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const title = {
    overview: 'Overview',
    mandates: 'Spend mandates',
    evidence: 'Integrity evidence',
    policy: 'Policy',
  }[view];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav className="primary-nav" aria-label="Primary">
          <NavButton
            label="Overview"
            icon="overview"
            active={view === 'overview'}
            onClick={() => setView('overview')}
          />
          <NavButton
            label="Mandates"
            icon="mandate"
            active={view === 'mandates'}
            onClick={() => setView('mandates')}
          />
          <NavButton
            label="Evidence"
            icon="evidence"
            active={view === 'evidence'}
            onClick={() => setView('evidence')}
          />
          <NavButton
            label="Policy"
            icon="policy"
            active={view === 'policy'}
            onClick={() => setView('policy')}
          />
        </nav>
        <div className="sidebar-foot">
          <div className="system-state">
            <span className={`live-dot ${health?.ok ? 'online' : ''}`} />
            <div>
              <strong>{health?.ok ? 'Warden online' : 'Connecting'}</strong>
              <span>{health?.mode ?? 'test'} environment</span>
            </div>
          </div>
          <button className="text-button" onClick={onUnauthorized}>
            Lock console
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">Operator control plane</span>
            <h1>{title}</h1>
          </div>
          <div className="header-actions">
            {health?.upstream_auth === 'needs_login' && (
              <span className="alert-chip">Rail connection needs attention</span>
            )}
            <button
              className="primary-button"
              onClick={() => setCreating(true)}
              data-testid="new-mandate"
            >
              <Icon name="plus" /> New mandate
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <strong>Warden could not refresh.</strong>
            <span>{error}</span>
            <button onClick={() => void refresh()}>Try again</button>
          </div>
        )}

        {loading ? (
          <LoadingState />
        ) : (
          <>
            {view === 'overview' && (
              <Overview
                stats={stats}
                mandates={mandates}
                evidence={evidence}
                events={events}
                health={health}
                onNewMandate={() => setCreating(true)}
                onOpenMandates={() => setView('mandates')}
                onOpenEvidence={(item) => {
                  setSelectedEvidence(item);
                  setView('evidence');
                }}
              />
            )}
            {view === 'mandates' && (
              <MandatesView
                token={token}
                mandates={mandates}
                onNewMandate={() => setCreating(true)}
                onRefresh={refresh}
              />
            )}
            {view === 'evidence' && (
              <EvidenceView
                evidence={evidence}
                receipts={receipts}
                onSelect={setSelectedEvidence}
              />
            )}
            {view === 'policy' && (
              <PolicyEditor token={token} onUnauthorized={onUnauthorized} />
            )}
          </>
        )}
      </main>

      {creating && (
        <MandateComposer
          token={token}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            setView('mandates');
            await refresh();
          }}
        />
      )}
      {selectedEvidence && (
        <EvidenceDrawer
          evidence={selectedEvidence}
          onClose={() => setSelectedEvidence(null)}
        />
      )}
    </div>
  );
}

function Overview({
  stats,
  mandates,
  evidence,
  events,
  health,
  onNewMandate,
  onOpenMandates,
  onOpenEvidence,
}: {
  stats: Stats | null;
  mandates: Mandate[];
  evidence: Evidence[];
  events: PolicyEvent[];
  health: Health | null;
  onNewMandate: () => void;
  onOpenMandates: () => void;
  onOpenEvidence: (evidence: Evidence) => void;
}) {
  const active = mandates.filter((mandate) => mandate.status === 'active');
  const featured = active[0];
  const latestBlock = events.find(
    (event) =>
      event.type === 'block' &&
      ['issuance', 'authorization', 'advisory'].includes(
        String(event.details.enforced_at ?? ''),
      ),
  );
  const hasDemoStory = health?.mode === 'test' && Boolean(evidence.length || latestBlock);

  return (
    <div className="view-stack enter">
      {hasDemoStory && (
        <DemoProofConsole
          mandates={mandates}
          evidence={evidence}
          block={latestBlock}
          onOpenEvidence={onOpenEvidence}
        />
      )}
      {!hasDemoStory && <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow accent">Authority layer for agent commerce</span>
          <h2>Every agent dollar starts with your decision.</h2>
          <p>
            Define the purpose, payee, ceiling, and expiry. Warden turns that intent into
            bounded execution and settlement evidence.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={onNewMandate}>
              Create authority <Icon name="arrow" />
            </button>
            <button className="secondary-button" onClick={onOpenMandates}>
              Review mandates
            </button>
          </div>
        </div>
        <div className="authority-diagram" aria-label="Authority lifecycle">
          <div className="authority-line" />
          <LifecycleNode step="01" title="Approve" detail="Operator mandate" active />
          <LifecycleNode step="02" title="Authorize" detail="Atomic reservation" active={active.length > 0} />
          <LifecycleNode step="03" title="Prove" detail="Integrity evidence" active={evidence.length > 0} />
        </div>
      </section>}

      <section className="metric-strip" aria-label="Key metrics">
        <Metric label="Active mandates" value={String(stats?.active_mandates ?? 0)} />
        <Metric
          label="Authority available"
          value={dollars(stats?.authority_available_cents ?? 0)}
        />
        <Metric label="Evidence records" value={String(stats?.evidence_total ?? 0)} />
        <Metric label="Prevented attempts" value={String(stats?.blocks_total ?? 0)} />
      </section>

      <div className="overview-grid">
        <section className="surface featured-authority">
          <SectionHeader
            eyebrow="Live authority"
            title={featured ? featured.merchant : 'No active mandate'}
            action={
              <button className="text-link" onClick={featured ? onOpenMandates : onNewMandate}>
                {featured ? 'View all' : 'Create one'} <Icon name="arrow" />
              </button>
            }
          />
          {featured ? (
            <MandateSpotlight mandate={featured} />
          ) : (
            <EmptyState
              icon="mandate"
              title="Create your first spend mandate"
              body="Give an agent bounded authority before it enters a checkout."
              action="Create mandate"
              onAction={onNewMandate}
            />
          )}
        </section>

        <section className="surface evidence-feed">
          <SectionHeader
            eyebrow="Recent outcomes"
            title="Evidence ledger"
            meta={evidence.length ? `${evidence.length} sealed` : undefined}
          />
          {evidence.length ? (
            <div className="timeline-list">
              {evidence.slice(0, 5).map((item) => (
                <button
                  key={item.id}
                  className="timeline-item"
                  onClick={() => onOpenEvidence(item)}
                >
                  <span className={`outcome-mark outcome-${item.outcome}`}>
                    <Icon name={item.decision === 'matched' ? 'check' : 'close'} />
                  </span>
                  <span className="timeline-copy">
                    <strong>
                      {dollars(item.amount_cents)} at {item.merchant}
                    </strong>
                    <span>{item.purpose}</span>
                  </span>
                  <span className="timeline-time">{relativeTime(item.created_at)}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="evidence"
              title="Evidence appears after settlement"
              body="Each verified outcome will be linked back to the exact authority that allowed it."
            />
          )}
        </section>

        <section className="surface assurance-panel">
          <SectionHeader eyebrow="Assurance" title="What Warden enforces" />
          <div className="assurance-list">
            <AssuranceRow label="Authority budget" detail="Atomic, cumulative" />
            <AssuranceRow label="Agent retry safety" detail="Idempotent" />
            <AssuranceRow label="Payee verification" detail="Checked at settlement" />
            <AssuranceRow label="Evidence integrity" detail="SHA-256 hash chain" />
          </div>
          <p className="assurance-note">
            Merchant settlement is verified against the mandate. Network-level merchant
            binding depends on rail capability.
          </p>
        </section>
      </div>
    </div>
  );
}

function DemoProofConsole({
  mandates,
  evidence,
  block,
  onOpenEvidence,
}: {
  mandates: Mandate[];
  evidence: Evidence[];
  block?: PolicyEvent;
  onOpenEvidence: (evidence: Evidence) => void;
}) {
  const [story, setStory] = useState<'blocked' | 'approved'>(block ? 'blocked' : 'approved');
  const approvedEvidence =
    evidence.find(
      (item) =>
        item.outcome === 'settled' &&
        item.decision === 'matched' &&
        item.merchant.toLowerCase().includes('staples'),
    ) ??
    evidence.find((item) => item.outcome === 'settled' && item.decision === 'matched');
  const approvedMandate = approvedEvidence
    ? mandates.find((mandate) => mandate.id === approvedEvidence.mandate_id)
    : undefined;
  const blockedMandate =
    mandates.find((mandate) => mandate.task_id === block?.task_id) ??
    mandates.find((mandate) => mandate.id === block?.details.mandate_id);
  const blockedRequest = block?.details.request;
  const blockedAmount = blockedRequest?.amount_cents ?? 0;
  const blockedMerchant = blockedRequest?.merchant ?? 'Out-of-scope merchant';
  const blockReason = block?.details.reasons?.[0]?.replaceAll('_', ' ') ?? 'outside approved authority';
  const verifiedChecks =
    approvedEvidence?.checks.filter((check) => check.result === 'pass').length ?? 0;

  return (
    <section className={`demo-proof-console story-${story}`} aria-label="Warden demo proof">
      <div className="demo-proof-header">
        <div>
          <span className="demo-environment">
            <span className="live-dot online" /> Deterministic test rail · real control loop
          </span>
          <h2>The credential that never existed is the product.</h2>
          <p>
            Warden turns a human decision into bounded agent execution—and proves what
            happened after the rail responds.
          </p>
        </div>
        <div className="demo-story-switch" aria-label="Choose demo moment">
          {block && (
            <button
              type="button"
              className={story === 'blocked' ? 'active blocked' : ''}
              onClick={() => setStory('blocked')}
              aria-pressed={story === 'blocked'}
            >
              Prevented attack
            </button>
          )}
          {approvedEvidence && (
            <button
              type="button"
              className={story === 'approved' ? 'active approved' : ''}
              onClick={() => setStory('approved')}
              aria-pressed={story === 'approved'}
            >
              Approved purchase
            </button>
          )}
        </div>
      </div>

      {story === 'blocked' && block ? (
        <>
          <div className="proof-chain">
            <ProofStage
              step="01"
              eyebrow="Human authority"
              title={blockedMandate?.merchant ?? 'Approved payee'}
              detail={blockedMandate?.purpose ?? 'Operator-approved purpose'}
              meta={
                blockedMandate
                  ? `${dollars(blockedMandate.per_transaction_limit_cents)} per purchase`
                  : 'Bounded mandate'
              }
            />
            <ProofArrow />
            <ProofStage
              step="02"
              eyebrow="Agent request"
              title={blockedMerchant}
              detail={`${dollars(blockedAmount)} requested after the payee changed`}
              meta="Outside the mandate"
              tone="danger"
            />
            <ProofArrow />
            <ProofStage
              step="03"
              eyebrow="Warden decision"
              title="Denied before credential"
              detail={titleCase(blockReason)}
              meta="$0 authority consumed"
              tone="blocked"
            />
          </div>
          <div className="proof-verdict blocked">
            <Icon name="shield" />
            <div>
              <strong>No card existed to steal or misuse.</strong>
              <span>
                The request stopped at authorization, before the payment rail received a
                credential.
              </span>
            </div>
            <span className="verdict-badge">Credential prevented</span>
          </div>
        </>
      ) : approvedEvidence ? (
        <>
          <div className="proof-chain">
            <ProofStage
              step="01"
              eyebrow="Human authority"
              title={approvedMandate?.merchant ?? approvedEvidence.merchant}
              detail={approvedEvidence.purpose}
              meta={
                approvedMandate
                  ? `${dollars(approvedMandate.amount_limit_cents)} total · ${dollars(approvedMandate.per_transaction_limit_cents)} per purchase`
                  : 'Bounded mandate'
              }
            />
            <ProofArrow />
            <ProofStage
              step="02"
              eyebrow="Agent execution"
              title={`${dollars(approvedEvidence.amount_cents)} at ${approvedEvidence.merchant}`}
              detail={`Requested by ${approvedEvidence.agent}`}
              meta="Atomically reserved"
            />
            <ProofArrow />
            <ProofStage
              step="03"
              eyebrow="Rail outcome"
              title="Settlement matched"
              detail={`${verifiedChecks}/${approvedEvidence.checks.length} checks passed`}
              meta={`Evidence #${approvedEvidence.integrity.sequence} · chain ${
                approvedEvidence.integrity.verified ? 'verified' : 'verification failed'
              }`}
              tone={approvedEvidence.integrity.verified ? 'approved' : 'danger'}
            />
          </div>
          <div className="proof-verdict approved">
            <Icon name="check" />
            <div>
              <strong>Outcome linked to the exact authority that allowed it.</strong>
              <span>Payee, amount, agent, purpose, and integrity checks remain inspectable.</span>
            </div>
            <button className="text-link" onClick={() => onOpenEvidence(approvedEvidence)}>
              Inspect evidence <Icon name="arrow" />
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ProofStage({
  step,
  eyebrow,
  title,
  detail,
  meta,
  tone = 'neutral',
}: {
  step: string;
  eyebrow: string;
  title: string;
  detail: string;
  meta: string;
  tone?: 'neutral' | 'danger' | 'blocked' | 'approved';
}) {
  return (
    <article className={`proof-stage tone-${tone}`}>
      <span className="proof-stage-number">{step}</span>
      <span className="eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
      <strong>{meta}</strong>
    </article>
  );
}

function ProofArrow() {
  return (
    <span className="proof-arrow" aria-hidden="true">
      <Icon name="arrow" />
    </span>
  );
}

function MandatesView({
  token,
  mandates,
  onNewMandate,
  onRefresh,
}: {
  token: string;
  mandates: Mandate[];
  onNewMandate: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Mandate | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Mandate['status'] | 'all'>('all');

  const visibleMandates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return mandates.filter((mandate) => {
      const matchesStatus = statusFilter === 'all' || mandate.status === statusFilter;
      const matchesQuery =
        !normalizedQuery ||
        [mandate.merchant, mandate.purpose, mandate.agent, mandate.task_id]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalizedQuery));
      return matchesStatus && matchesQuery;
    });
  }, [mandates, query, statusFilter]);

  const activate = async (mandate: Mandate) => {
    setBusy(mandate.id);
    setActionError(null);
    try {
      await api.activateMandate(token, mandate.id);
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="view-stack enter">
      <section className="view-intro">
        <div>
          <span className="eyebrow accent">Authority registry</span>
          <h2>Bounded permission, made explicit.</h2>
          <p>
            Active terms are immutable. To change the payee, purpose, amount, or expiry,
            revoke the authority and issue a new mandate.
          </p>
        </div>
        <div className="registry-count">
          <strong>{mandates.length}</strong>
          <span>Total records</span>
        </div>
      </section>

      {actionError && <div className="inline-error">{actionError}</div>}

      {mandates.length ? (
        <>
          <RegistryControls
            query={query}
            onQueryChange={setQuery}
            activeFilter={statusFilter}
            filters={['all', 'active', 'draft', 'exhausted', 'revoked', 'expired']}
            onFilterChange={(value) => setStatusFilter(value as Mandate['status'] | 'all')}
            count={visibleMandates.length}
            total={mandates.length}
            label="mandates"
          />
          {visibleMandates.length ? (
          <section className="mandate-registry">
          <div className="registry-head">
            <span>Authority</span><span>Usage</span><span>State</span><span className="visually-hidden">Actions</span>
          </div>
          {visibleMandates.map((mandate) => {
            const consumed = mandate.reserved_cents + mandate.settled_cents;
            const percent = Math.min(100, (consumed / mandate.amount_limit_cents) * 100);
            return (
              <article className="mandate-row" key={mandate.id} data-testid="mandate-row">
                <div className="mandate-identity">
                  <span className="merchant-monogram">{mandate.merchant.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{mandate.merchant}</strong>
                    <span>{mandate.purpose}</span>
                    <small>
                      <Icon name="agent" /> {mandate.agent}
                      <span className="dot-separator" />
                      <Icon name="clock" /> Expires {formatDate(mandate.expires_at)}
                    </small>
                  </div>
                </div>
                <div className="usage-cell">
                  <div className="usage-line">
                    <strong>{dollars(consumed)}</strong>
                    <span>of {dollars(mandate.amount_limit_cents)}</span>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <small>
                    {mandate.transaction_count} of {mandate.max_transactions} uses
                  </small>
                </div>
                <div className="status-cell">
                  <StatusPill status={mandate.status} />
                  <span>{mandate.rail === 'auto' ? 'Any configured rail' : mandate.rail}</span>
                </div>
                <div className="row-actions">
                  {mandate.status === 'draft' && (
                    <button
                      className="secondary-button compact"
                      disabled={busy === mandate.id}
                      onClick={() => void activate(mandate)}
                    >
                      Activate
                    </button>
                  )}
                  {(mandate.status === 'active' || mandate.status === 'draft') && (
                    <button
                      className="ghost-button compact danger"
                      disabled={busy === mandate.id}
                      onClick={() => setRevoking(mandate)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          </section>
          ) : (
            <FilteredEmptyState
              icon="mandate"
              title="No mandates match these filters"
              body="Try a different status or clear your search to see the full authority registry."
              onClear={() => { setQuery(''); setStatusFilter('all'); }}
            />
          )}
        </>
      ) : (
        <section className="surface">
          <EmptyState
            icon="mandate"
            title="No authority has been issued"
            body="Create a mandate to define exactly where an agent can spend, how much, and why."
            action="Create your first mandate"
            onAction={onNewMandate}
          />
        </section>
      )}
      {revoking && (
        <RevokeMandateDialog
          mandate={revoking}
          busy={busy === revoking.id}
          onClose={() => setRevoking(null)}
          onConfirm={async (reason) => {
            setBusy(revoking.id);
            setActionError(null);
            try {
              await api.revokeMandate(token, revoking.id, reason);
              setRevoking(null);
              await onRefresh();
            } catch (error) {
              setActionError(error instanceof Error ? error.message : String(error));
              setRevoking(null);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </div>
  );
}

function RevokeMandateDialog({
  mandate,
  busy,
  onClose,
  onConfirm,
}: {
  mandate: Mandate;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  return (
    <ModalShell onClose={busy ? () => undefined : onClose}>
      <aside
        className="composer revoke-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revoke-title"
      >
        <div className="drawer-header">
          <div>
            <span className="eyebrow danger-text">Irreversible action</span>
            <h2 id="revoke-title">Revoke {mandate.merchant} authority?</h2>
            <p>
              {dollars(mandate.amount_available_cents)} remains available. Warden will close
              unused credentials and keep any settlement already in flight under review.
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onConfirm(reason.trim());
          }}
        >
          <Field label="Reason" hint="Recorded with the mandate closure">
            <textarea
              required
              minLength={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Order cancelled by operator"
              autoFocus
            />
          </Field>
          <div className="composer-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Keep active
            </button>
            <button
              type="submit"
              className="danger-button"
              disabled={busy || reason.trim().length < 3}
            >
              {busy ? 'Revoking…' : 'Revoke authority'}
            </button>
          </div>
        </form>
      </aside>
    </ModalShell>
  );
}

function EvidenceView({
  evidence,
  receipts,
  onSelect,
}: {
  evidence: Evidence[];
  receipts: Receipt[];
  onSelect: (evidence: Evidence) => void;
}) {
  const [query, setQuery] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<Evidence['outcome'] | 'all'>('all');
  const unboundReceipts = receipts.filter((receipt) => !receipt.mandate_id);
  const visibleEvidence = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return evidence.filter((item) => {
      const matchesOutcome = outcomeFilter === 'all' || item.outcome === outcomeFilter;
      const matchesQuery = !normalizedQuery || [item.merchant, item.purpose, item.agent, item.transaction_id]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
      return matchesOutcome && matchesQuery;
    });
  }, [evidence, outcomeFilter, query]);
  return (
    <div className="view-stack enter">
      <section className="view-intro">
        <div>
          <span className="eyebrow accent">Append-only outcomes</span>
          <h2>Trace every settlement back to authority.</h2>
          <p>
            Evidence records pair rail-observed facts with the immutable mandate and
            policy snapshot that authorized them.
          </p>
        </div>
        <div className="integrity-key">
          <span className="seal-icon"><Icon name="shield" /></span>
          <div>
            <strong>
              {evidence.every((item) => item.integrity.verified)
                ? 'Verified SHA-256 chain'
                : 'Integrity check failed'}
            </strong>
            <span>
              {evidence.every((item) => item.integrity.verified)
                ? 'Local tamper evidence'
                : 'Review the evidence store'}
            </span>
          </div>
        </div>
      </section>

      {evidence.length ? (
        <>
          <RegistryControls
            query={query}
            onQueryChange={setQuery}
            activeFilter={outcomeFilter}
            filters={['all', 'settled', 'pending', 'declined', 'reversed', 'refunded', 'violation']}
            onFilterChange={(value) => setOutcomeFilter(value as Evidence['outcome'] | 'all')}
            count={visibleEvidence.length}
            total={evidence.length}
            label="evidence"
          />
          {visibleEvidence.length ? (
          <section className="evidence-table">
          <div className="evidence-table-head">
            <span>Outcome</span>
            <span>Authority</span>
            <span>Integrity</span>
            <span>Time</span>
          </div>
          {visibleEvidence.map((item) => (
            <button
              className="evidence-row"
              key={item.id}
              onClick={() => onSelect(item)}
              data-testid="evidence-row"
            >
              <span className="evidence-outcome">
                <span className={`outcome-mark outcome-${item.outcome}`}>
                  <Icon name={item.decision === 'matched' ? 'check' : 'close'} />
                </span>
                <span>
                  <strong>{dollars(item.amount_cents)}</strong>
                  <small>{item.merchant}</small>
                </span>
              </span>
              <span className="evidence-authority">
                <strong>{item.purpose}</strong>
                <small>{item.agent}</small>
              </span>
              <span className="hash-cell">
                <strong>
                  {item.integrity.verified ? 'Verified' : 'Failed'} · #
                  {String(item.integrity.sequence).padStart(3, '0')}
                </strong>
                <code>{shortHash(item.integrity.evidence_hash)}</code>
              </span>
              <span className="evidence-time">
                {formatDateTime(item.created_at)}
                <Icon name="arrow" />
              </span>
            </button>
          ))}
          </section>
          ) : (
            <FilteredEmptyState
              icon="evidence"
              title="No evidence matches these filters"
              body="Change the outcome filter or clear your search to return to the full ledger."
              onClear={() => { setQuery(''); setOutcomeFilter('all'); }}
            />
          )}
        </>
      ) : (
        <section className="surface">
          <EmptyState
            icon="evidence"
            title="The evidence ledger is ready"
            body="Settled mandate purchases will appear here with their authorization checks and integrity hash."
          />
        </section>
      )}

      {unboundReceipts.length > 0 && (
        <section className="legacy-note">
          <Icon name="clock" />
          <div>
            <strong>{unboundReceipts.length} legacy receipt records</strong>
            <span>
              These predate mandate authority and remain available through the receipts API.
            </span>
          </div>
        </section>
      )}
    </div>
  );
}

function MandateComposer({
  token,
  onClose,
  onCreated,
}: {
  token: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [usage, setUsage] = useState<'once' | 'reusable'>('once');
  const [advanced, setAdvanced] = useState(false);
  const [form, setForm] = useState({
    agent: 'procurement-agent',
    purpose: '',
    merchant: '',
    budget: '',
    perTransaction: '',
    maxTransactions: '3',
    expiresAt: defaultExpiry(),
    rail: 'auto' as CreateMandateInput['rail'],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent, activateNow: boolean) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const amount = Math.round(Number(form.budget) * 100);
    const perTransaction = form.perTransaction
      ? Math.round(Number(form.perTransaction) * 100)
      : amount;
    try {
      await api.createMandate(token, {
        agent_name: form.agent.trim(),
        purpose: form.purpose.trim(),
        merchant: form.merchant.trim(),
        amount_limit_cents: amount,
        per_transaction_limit_cents: perTransaction,
        max_transactions: usage === 'once' ? 1 : Number(form.maxTransactions),
        expires_at: new Date(form.expiresAt).toISOString(),
        rail: form.rail,
        activate_now: activateNow,
      });
      await onCreated();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <aside className="composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div className="drawer-header">
          <div>
            <span className="eyebrow accent">New authority</span>
            <h2 id="composer-title">Create a spend mandate</h2>
            <p>Terms become immutable when activated.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event, true)}>
          <div className="form-section">
            <span className="form-section-label">Who and why</span>
            <Field label="Agent" hint="The delegate receiving authority">
              <div className="input-with-icon">
                <Icon name="agent" />
                <input
                  required
                  value={form.agent}
                  onChange={(event) => setForm({ ...form, agent: event.target.value })}
                  placeholder="procurement-agent"
                  data-testid="mandate-agent"
                />
              </div>
            </Field>
            <Field label="Purpose" hint="A concrete outcome, not a generic task">
              <textarea
                required
                minLength={3}
                rows={3}
                value={form.purpose}
                onChange={(event) => setForm({ ...form, purpose: event.target.value })}
                placeholder="Buy printer paper for the New York office"
                data-testid="mandate-purpose"
              />
            </Field>
          </div>

          <div className="form-section">
            <span className="form-section-label">Boundaries</span>
            <div className="two-column-fields">
              <Field label="Payee" hint="Required; verified again at settlement">
                <div className="input-with-icon">
                  <Icon name="merchant" />
                  <input
                    required
                    value={form.merchant}
                    onChange={(event) => setForm({ ...form, merchant: event.target.value })}
                    placeholder="Staples"
                    data-testid="mandate-merchant"
                  />
                </div>
              </Field>
              <Field label="Total budget" hint="Cumulative ceiling">
                <div className="money-input">
                  <span>$</span>
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={form.budget}
                    onChange={(event) => setForm({ ...form, budget: event.target.value })}
                    placeholder="40.00"
                    data-testid="mandate-budget"
                  />
                </div>
              </Field>
            </div>
            <Field label="Usage">
              <div className="segmented-control">
                <button
                  type="button"
                  className={usage === 'once' ? 'active' : ''}
                  onClick={() => setUsage('once')}
                >
                  One purchase
                </button>
                <button
                  type="button"
                  className={usage === 'reusable' ? 'active' : ''}
                  onClick={() => setUsage('reusable')}
                >
                  Reusable
                </button>
              </div>
            </Field>
            <Field label="Expires" hint="Authority closes automatically">
              <input
                required
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm({ ...form, expiresAt: event.target.value })}
                data-testid="mandate-expiry"
              />
            </Field>
          </div>

          <button
            type="button"
            className="advanced-toggle"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
          >
            <span>More controls</span>
            <Icon name="arrow" />
          </button>
          {advanced && (
            <div className="advanced-fields">
              <Field label="Per-purchase ceiling">
                <div className="money-input">
                  <span>$</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.perTransaction}
                    onChange={(event) =>
                      setForm({ ...form, perTransaction: event.target.value })
                    }
                    placeholder={form.budget || '40.00'}
                  />
                </div>
              </Field>
              {usage === 'reusable' && (
                <Field label="Maximum purchases">
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={form.maxTransactions}
                    onChange={(event) =>
                      setForm({ ...form, maxTransactions: event.target.value })
                    }
                  />
                </Field>
              )}
              <Field label="Payment rail">
                <select
                  value={form.rail}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      rail: event.target.value as CreateMandateInput['rail'],
                    })
                  }
                >
                  <option value="auto">Any configured rail</option>
                  <option value="agentcard">AgentCard</option>
                  <option value="stripe">Stripe</option>
                </select>
              </Field>
            </div>
          )}

          {error && <div className="inline-error">{error}</div>}
          <div className="composer-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={submitting}
              onClick={(event) => void submit(event as unknown as FormEvent, false)}
            >
              Save draft
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={submitting}
              data-testid="activate-mandate"
            >
              {submitting ? 'Creating authority…' : 'Create and activate'}
              {!submitting && <Icon name="arrow" />}
            </button>
          </div>
        </form>
      </aside>
    </ModalShell>
  );
}

function EvidenceDrawer({
  evidence,
  onClose,
}: {
  evidence: Evidence;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <aside className="evidence-drawer" role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div>
            <span className="eyebrow accent">Evidence #{String(evidence.integrity.sequence).padStart(3, '0')}</span>
            <h2>
              {dollars(evidence.amount_cents)} at {evidence.merchant}
            </h2>
            <p>{formatDateTime(evidence.created_at)}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className={`decision-banner ${evidence.decision}`}>
          <span className="seal-icon">
            <Icon name={evidence.decision === 'matched' ? 'check' : 'close'} />
          </span>
          <div>
            <strong>
              {evidence.decision === 'matched'
                ? 'Transaction matched its authority'
                : 'Transaction requires review'}
            </strong>
            <span>
              {evidence.decision === 'matched'
                ? 'Rail-observed facts align with the approved mandate.'
                : 'One or more observed facts did not match the mandate.'}
            </span>
          </div>
        </div>

        <section className="drawer-section">
          <span className="form-section-label">Authorization chain</span>
          <div className="chain">
            <ChainItem label="Operator authority" value={String(evidence.mandate['approved_by'] ?? 'Local operator')} />
            <ChainItem label="Purpose" value={evidence.purpose} />
            <ChainItem label="Agent" value={evidence.agent} />
            <ChainItem label="Observed outcome" value={`${evidence.merchant} · ${dollars(evidence.amount_cents)}`} />
          </div>
        </section>

        <section className="drawer-section">
          <span className="form-section-label">Verification checks</span>
          <div className="check-list">
            {evidence.checks.map((check) => (
              <div className="check-row" key={check.code}>
                <span className={`check-icon ${check.result}`}>
                  <Icon name={check.result === 'pass' ? 'check' : 'close'} />
                </span>
                <div>
                  <strong>{titleCase(check.code)}</strong>
                  <span>{check.explanation}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="drawer-section integrity-block">
          <div>
            <span className="form-section-label">Integrity seal</span>
            <strong>
              {evidence.integrity.verified ? 'Verified SHA-256 chain' : 'Integrity check failed'}
              , sequence {evidence.integrity.sequence}
            </strong>
          </div>
          <code>{evidence.integrity.evidence_hash}</code>
          <p>
            Previous record:{' '}
            {evidence.integrity.previous_hash
              ? shortHash(evidence.integrity.previous_hash)
              : 'Genesis record'}
          </p>
        </section>
      </aside>
    </ModalShell>
  );
}

function PolicyEditor({
  token,
  onUnauthorized,
}: {
  token: string;
  onUnauthorized: () => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState('');
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [rules, setRules] = useState<PolicyRules>(DEFAULT_RULES);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const loadPolicy = useCallback(
    async (name: string | null) => {
      try {
        const response = await api.policies(token, name);
        setVersions(response.versions);
        setRules(response.active?.rules ?? DEFAULT_RULES);
        setStatus('idle');
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else {
          setStatus('error');
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [token, onUnauthorized],
  );

  useEffect(() => {
    void api
      .agents(token)
      .then((response) => setAgents(response.agents))
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else {
          setStatus('error');
          setMessage(error instanceof Error ? error.message : String(error));
        }
      });
  }, [token, onUnauthorized]);
  useEffect(() => {
    setAgentDraft(agentName ?? '');
    void loadPolicy(agentName);
  }, [agentName, loadPolicy]);

  const save = async () => {
    setStatus('saving');
    try {
      const response = await api.putPolicy(token, agentName, rules);
      setStatus('saved');
      setMessage(`Version ${response.active?.version ?? 1} is active`);
      await loadPolicy(agentName);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }
  };

  return (
    <div className="view-stack enter">
      <section className="view-intro">
        <div>
          <span className="eyebrow accent">Defense in depth</span>
          <h2>Set the outer safety envelope.</h2>
          <p>
            Mandates express human intent. Policy provides the organization-wide ceiling
            that no mandate can exceed.
          </p>
        </div>
        <div className="policy-scope">
          <label htmlFor="policy-agent">Policy scope</label>
          <input
            id="policy-agent"
            list="policy-agents"
            value={agentDraft}
            placeholder="Global default"
            onChange={(event) => setAgentDraft(event.target.value)}
            onBlur={() => setAgentName(agentDraft.trim() || null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setAgentName(agentDraft.trim() || null);
            }}
          />
          <datalist id="policy-agents">
            {agents.map((agent) => (
              <option key={agent.id} value={agent.name} />
            ))}
          </datalist>
        </div>
      </section>

      <section className="surface policy-surface">
        <SectionHeader
          eyebrow={agentName ? `Agent · ${agentName}` : 'Global default'}
          title="Spend boundaries"
          meta={versions[0] ? `Version ${versions[0].version}` : 'Not yet saved'}
        />
        <div className="policy-form-grid">
          <CsvField
            label="Allowed merchants"
            hint="Empty allows any merchant not blocked"
            values={rules.allowed_merchants}
            placeholder="Staples, AWS"
            onChange={(values) => setRules({ ...rules, allowed_merchants: values })}
          />
          <CsvField
            label="Blocked merchants"
            values={rules.blocked_merchants}
            placeholder="Gift card marketplace"
            onChange={(values) => setRules({ ...rules, blocked_merchants: values })}
          />
          <CsvField
            label="Allowed categories"
            hint="Empty allows any category"
            values={rules.allowed_categories}
            placeholder="office_supplies, cloud_hosting"
            onChange={(values) => setRules({ ...rules, allowed_categories: values })}
          />
          <MerchantCapsField
            caps={rules.per_merchant_caps}
            onChange={(caps) => setRules({ ...rules, per_merchant_caps: caps })}
          />
          <Field label="Default rail">
            <select
              value={rules.default_rail}
              onChange={(event) =>
                setRules({
                  ...rules,
                  default_rail: event.target.value as PolicyRules['default_rail'],
                })
              }
            >
              <option value="agentcard">AgentCard</option>
              <option value="stripe">Stripe</option>
            </select>
          </Field>
          <MoneyPolicyField
            label="Per-card ceiling"
            cents={rules.per_card_cap_cents}
            onChange={(value) => setRules({ ...rules, per_card_cap_cents: value })}
          />
          <MoneyPolicyField
            label="Per-task ceiling"
            cents={rules.per_task_budget_cents}
            onChange={(value) => setRules({ ...rules, per_task_budget_cents: value })}
          />
          <MoneyPolicyField
            label="Approval threshold"
            hint="0 disables the threshold"
            cents={rules.approval_threshold_cents}
            onChange={(value) => setRules({ ...rules, approval_threshold_cents: value })}
          />
          <Field label="Credential TTL" hint="Minutes before an unused card expires">
            <input
              type="number"
              min="1"
              value={rules.card_ttl_minutes}
              onChange={(event) =>
                setRules({
                  ...rules,
                  card_ttl_minutes: Math.max(1, Number(event.target.value) || 1),
                })
              }
            />
          </Field>
          <Field label="Cards per hour" hint="0 means no velocity ceiling">
            <input
              type="number"
              min="0"
              value={rules.velocity.max_cards_per_hour}
              onChange={(event) =>
                setRules({
                  ...rules,
                  velocity: {
                    ...rules.velocity,
                    max_cards_per_hour: Math.max(0, Number(event.target.value) || 0),
                  },
                })
              }
            />
          </Field>
          <MoneyPolicyField
            label="Daily spend ceiling"
            hint="0 means no daily ceiling"
            cents={rules.velocity.max_amount_cents_per_day}
            onChange={(value) =>
              setRules({
                ...rules,
                velocity: { ...rules.velocity, max_amount_cents_per_day: value },
              })
            }
          />
        </div>
        <div className="policy-save-row">
          <button
            className="primary-button"
            disabled={status === 'saving'}
            onClick={() => void save()}
          >
            {status === 'saving' ? 'Saving…' : 'Save as new version'}
          </button>
          {status !== 'idle' && status !== 'saving' && (
            <span className={status === 'error' ? 'save-state error' : 'save-state'}>
              <Icon name={status === 'error' ? 'close' : 'check'} /> {message}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function MandateSpotlight({ mandate }: { mandate: Mandate }) {
  const consumed = mandate.reserved_cents + mandate.settled_cents;
  const percent = Math.min(100, (consumed / mandate.amount_limit_cents) * 100);
  return (
    <div className="spotlight-content">
      <div className="spotlight-purpose">“{mandate.purpose}”</div>
      <div className="spotlight-meta">
        <span><Icon name="agent" /> {mandate.agent}</span>
        <span><Icon name="clock" /> {formatDate(mandate.expires_at)}</span>
      </div>
      <div className="authority-meter">
        <div className="authority-amounts">
          <div>
            <span>Available</span>
            <strong>{dollars(mandate.amount_available_cents)}</strong>
          </div>
          <div>
            <span>Authorized</span>
            <strong>{dollars(mandate.amount_limit_cents)}</strong>
          </div>
        </div>
        <div className="progress-track large">
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="authority-foot">
          <span>{mandate.transaction_count} / {mandate.max_transactions} uses</span>
          <StatusPill status={mandate.status} />
        </div>
      </div>
      <div className="spotlight-proof">
        <div><Icon name="shield" /><span>Mandate hash</span></div>
        <code>{shortHash(mandate.mandate_hash)}</code>
      </div>
    </div>
  );
}

function LifecycleNode({
  step,
  title,
  detail,
  active,
}: {
  step: string;
  title: string;
  detail: string;
  active: boolean;
}) {
  return (
    <div className={`lifecycle-node ${active ? 'active' : ''}`}>
      <span>{active ? <Icon name="check" /> : step}</span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function AssuranceRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="assurance-row">
      <span className="check-icon pass"><Icon name="check" /></span>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

function StatusPill({ status }: { status: Mandate['status'] }) {
  return <span className={`status-pill status-${status}`}><span />{titleCase(status)}</span>;
}

function SectionHeader({
  eyebrow,
  title,
  meta,
  action,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <div><span className="eyebrow">{eyebrow}</span><h3>{title}</h3></div>
      {meta && <span className="section-meta">{meta}</span>}
      {action}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} /></span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action && onAction && <button className="secondary-button" onClick={onAction}>{action}</button>}
    </div>
  );
}

function RegistryControls({
  query,
  onQueryChange,
  activeFilter,
  filters,
  onFilterChange,
  count,
  total,
  label,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  activeFilter: string;
  filters: readonly string[];
  onFilterChange: (value: string) => void;
  count: number;
  total: number;
  label: string;
}) {
  return (
    <div className="registry-controls" aria-label={`Filter ${label}`}>
      <label className="search-field">
        <span className="visually-hidden">Search {label}</span>
        <Icon name="search" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search merchant, purpose, or agent"
        />
      </label>
      <div className="filter-tabs" aria-label={`${label} status`}>
        {filters.map((filter) => (
          <button
            key={filter}
            type="button"
            className={activeFilter === filter ? 'active' : ''}
            aria-pressed={activeFilter === filter}
            onClick={() => onFilterChange(filter)}
          >
            {filter === 'all' ? 'All' : titleCase(filter)}
          </button>
        ))}
      </div>
      <span className="filter-count" aria-live="polite">{count} of {total}</span>
    </div>
  );
}

function FilteredEmptyState({
  icon,
  title,
  body,
  onClear,
}: {
  icon: IconName;
  title: string;
  body: string;
  onClear: () => void;
}) {
  return (
    <section className="surface filter-empty-state">
      <EmptyState icon={icon} title={title} body={body} action="Clear filters" onAction={onClear} />
    </section>
  );
}

function LoadingState() {
  return (
    <div className="loading-grid" aria-label="Loading">
      <div className="skeleton skeleton-hero" />
      <div className="skeleton skeleton-strip" />
      <div className="skeleton skeleton-card" />
      <div className="skeleton skeleton-card" />
    </div>
  );
}

function NavButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  );
}

function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark"><span /></span>
      <span className="logo-type">Warden</span>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <small>{hint}</small>}</span>
      {children}
    </label>
  );
}

function CsvField({
  label,
  hint,
  values,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        value={values.join(', ')}
        placeholder={placeholder}
        onChange={(event) =>
          onChange(event.target.value.split(',').map((value) => value.trim()).filter(Boolean))
        }
      />
    </Field>
  );
}

function MoneyPolicyField({
  label,
  hint,
  cents,
  onChange,
}: {
  label: string;
  hint?: string;
  cents: number;
  onChange: (cents: number) => void;
}) {
  const [draft, setDraft] = useState((cents / 100).toFixed(2));
  useEffect(() => setDraft((cents / 100).toFixed(2)), [cents]);
  const commit = () => {
    const value = Math.max(0, Math.round((Number(draft) || 0) * 100));
    onChange(value);
    setDraft((value / 100).toFixed(2));
  };
  return (
    <Field label={label} hint={hint}>
      <div className="money-input">
        <span>$</span>
        <input
          inputMode="decimal"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      </div>
    </Field>
  );
}

function MerchantCapsField({
  caps,
  onChange,
}: {
  caps: Record<string, number>;
  onChange: (caps: Record<string, number>) => void;
}) {
  const format = (value: Record<string, number>) =>
    Object.entries(value)
      .map(([merchant, cents]) => `${merchant}: ${(cents / 100).toFixed(2)}`)
      .join('\n');
  const [draft, setDraft] = useState(format(caps));
  useEffect(() => setDraft(format(caps)), [caps]);
  const commit = () => {
    const next: Record<string, number> = {};
    for (const line of draft.split('\n')) {
      const separator = line.lastIndexOf(':');
      if (separator < 1) continue;
      const merchant = line.slice(0, separator).trim();
      const dollars = Number(line.slice(separator + 1).replace('$', '').trim());
      if (merchant && Number.isFinite(dollars) && dollars > 0) {
        next[merchant] = Math.round(dollars * 100);
      }
    }
    onChange(next);
  };
  return (
    <Field
      label="Per-merchant ceilings"
      hint="One per line, for example: AWS: 50.00"
    >
      <textarea
        value={draft}
        placeholder={'AWS: 50.00\nStaples: 25.00'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </Field>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" onClick={onClose} aria-label="Close dialog" />
      {children}
    </div>
  );
}

function ChainItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="chain-item">
      <span><Icon name="check" /></span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    overview: <><path d="M4 5.5h6v6H4zM14 5.5h6v3h-6zM14 12.5h6v6h-6zM4 15.5h6v3H4z" /></>,
    mandate: <><path d="M6 3.5h9l3 3v14H6z" /><path d="M15 3.5v4h4M9 11h6M9 15h6" /></>,
    evidence: <><path d="M12 3.5 19 7v5c0 4.5-3 7.2-7 8.5C8 19.2 5 16.5 5 12V7z" /><path d="m9 12 2 2 4-4" /></>,
    policy: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    shield: <><path d="M12 3.5 19 7v5c0 4.5-3 7.2-7 8.5C8 19.2 5 16.5 5 12V7z" /><path d="m9 12 2 2 4-4" /></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    check: <><path d="m6 12 4 4 8-9" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
    merchant: <><path d="M4 9h16l-2-5H6zM6 9v11h12V9M9 20v-6h6v6" /></>,
    agent: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6" /></>,
    search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function shortHash(value: string | null | undefined): string {
  if (!value) return 'Pending activation';
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
