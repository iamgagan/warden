# Warden — Technical Specification (SPEC.md)

**Version:** 1.3 · 2026-07-24
**Status:** Source of truth for implementation. A coding model (Codex) should be able to start at Task T1 and proceed strictly in order without further clarification.
**Changelog v1.3:** Multi-rail pivot. §2.7 renamed to cover the upstream boundary generally; a second `UpstreamClient` implementation (`packages/upstream-stripe`, Stripe Issuing test mode) is added alongside AgentCard. `cards.rail` column added. This was a deliberate scope change made under time pressure ahead of an investor demo — see §2.4 item 7 and the new §2.8 for the rationale and what changed vs. what stayed true.
**Changelog v1.2:** Ship Season is a 6-week season ending Aug 16, 2026 (not 12 weeks). Roadmap phases remapped to the 6-week calendar; task order unchanged. T17 (categorization + budgets) downgraded to stretch goal.
**Changelog v1.1:** Upstream auth rewritten for OAuth 2.0 + PKCE (verified: static bearer headers are rejected; access tokens live ~5 minutes). Card lifecycle changed from card-per-task to card-per-purchase (verified: upstream cards are $1–$50, auto-cancel after one authorized payment, expire after 7 days unused). Sandbox is a per-call flag. Added mock upstream server so implementation and CI never require live credentials.
**Companion docs (strategy, not needed for coding):** `~/Documents/Startup Ideas/Warden - AgentCard Spend Guardrails - Ship Season Build Spec.md`, `Warden - CEO Review - 2026-07-06.md`

---

## 1. Executive Summary

Warden is a spend-guardrails and audit-receipts layer for AI agents that pay with virtual cards, built on top of the AgentCard MCP server. It enforces human-set spending policy deterministically by minting purpose-scoped single-use cards whose limits are applied at the card network (non-bypassable by the agent), and it binds every resulting charge to the agent's triggering intent, producing an explainable receipt log that aligns with the record-retention duties in the 2026 card-network agentic-commerce rules. It is positioned as the agent-side implementation of intent capture and audit — not as fraud detection or security tooling — for developers who run agents that spend money.

## 2. Technical Architecture

### 2.1 System overview

Warden sits between the agent and the upstream `agent-cards` MCP server as a proxying MCP server, plus a local persistence layer and a web dashboard.

```
┌─────────┐   MCP    ┌──────────────────┐   MCP over HTTP   ┌──────────────────┐
│  Agent  │ ───────▶ │  warden-mcp       │ ────────────────▶ │ agent-cards       │
│ (any)   │          │  (proxy + policy) │   (OAuth 2.0)     │ mcp.agentcard.sh  │
└─────────┘          └────────┬─────────┘                    └──────────────────┘
                              │ writes                        ▲ same interface
                              ▼                               │
                     ┌──────────────────┐        ┌────────────┴─────┐
                     │  SQLite (WAL)     │ ◀───── │ reconciler        │  (polls upstream
                     │  warden.db        │        │ (background loop) │   list_transactions)
                     └────────┬─────────┘        └──────────────────┘
                              │ reads/writes                  ▲ tests run against
                              ▼                               │
                     ┌──────────────────┐        ┌────────────┴─────┐
                     │  warden-api       │ ◀───── │ mock-agentcard    │  (in-process MCP
                     │  (Hono, JSON)     │  HTTP  │ (test double)     │   server, no network)
                     └──────────────────┘        └──────────────────┘
                              ▲
                     ┌────────┴─────────┐
                     │  warden-web       │
                     │  (Vite + React)   │
                     └──────────────────┘
```

### 2.2 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict), Node.js ≥ 22 | MCP SDK is TS-first; one language across all packages |
| Monorepo | pnpm workspaces | Simple, no build orchestration needed |
| MCP server/client | `@modelcontextprotocol/sdk` | Warden is both an MCP server (to the agent) and an MCP client (to agent-cards) |
| Upstream auth | OAuth 2.0 authorization code + PKCE + refresh token | The upstream MCP mandates it (see §2.7); static bearer headers are rejected |
| Database | SQLite via `better-sqlite3` + `drizzle-orm` | Single-file, zero-ops, append-friendly; solo-builder scale |
| Validation | `zod` | Every external input (MCP tool args, API bodies, policy JSON) is zod-validated |
| API server | `hono` (@hono/node-server) | Small, typed, trivial for codegen |
| Dashboard | Vite + React 18 + TypeScript, plain CSS | No SSR needed; SPA served by warden-api in production |
| Testing | `vitest` + mock-agentcard | All tests run offline; live E2E gated behind `AGENTCARD_E2E=1` |

### 2.3 Package layout

```
warden/
  package.json            # pnpm workspace root
  packages/
    core/                 # policy engine, receipt store, domain types (pure, no I/O)
    db/                   # drizzle schema, migrations, repository functions
    upstream/             # OAuth token manager + typed agent-cards MCP client
    mock-agentcard/       # in-process MCP server implementing the upstream tool surface
    upstream-stripe/      # UpstreamClient over Stripe Issuing (test mode), second rail (v1.3)
    mcp/                  # warden-mcp server (proxy) + reconciler loop
    api/                  # warden-api Hono server (serves JSON + static web build)
    cli/                  # `warden` CLI: auth bootstrap, serve, seed
  apps/
    web/                  # warden-web dashboard (Vite React SPA)
  SPEC.md
```

### 2.4 Core design patterns (agreed in brainstorm, revised v1.1)

1. **Network-level enforcement, software-level advice.** Hard limits live on the card itself: the policy engine's output is the *parameter set passed to `create_card`* (amount cap in cents; upstream enforces single-authorization and 7-day expiry). Software pre-checks may decline earlier for better error messages, but the card is always the real gate. A compromised or prompt-injected agent that bypasses Warden's checks still hits the network decline.
2. **One single-use card per purchase; task = budget envelope.** Upstream cards auto-cancel after one authorized payment and are capped at $50, so the natural unit is card-per-purchase. A Warden *task* carries the intent and a cumulative budget; each purchase inside it mints a fresh scoped card via `warden_issue_card`. Warden's deterministic gate is at issuance: it refuses to mint when the cumulative task budget, policy caps, or velocity limits would be exceeded. Blast radius of any single leaked credential = one card ≤ $50 ≤ remaining budget.
3. **Intent binding at the boundary.** Every Warden MCP tool that can lead to spend requires an `intent` string (the goal/prompt that triggered the task). Receipts are the join: `transaction → card → task → intent → policy decision`.
4. **Deterministic policy only.** The enforcement path contains no LLM/ML calls and no network calls other than to the upstream agent-cards MCP. Same inputs always produce the same decision. (Categorization for analytics may be heuristic, but it never gates a payment.)
5. **Append-only audit.** Receipts and policy events are never updated or deleted, matching Visa Rules §4.1.24 record-retention framing (consent/instruction records producible on request). Corrections are new rows.
6. **Money as integer cents, time as UTC ISO 8601.** Everywhere, no exceptions.
7. **Upstream is swappable.** `packages/upstream` exposes an `UpstreamClient` interface; `RealUpstream` (AgentCard), `MockUpstream` (`mock-agentcard`), and `StripeUpstream` (`upstream-stripe`, v1.3) all implement it. Everything else — policy engine, reconciler, receipts, API, dashboard — depends only on the interface, never on which rail is behind it.

### 2.5 Data model (drizzle/SQLite)

```
agents        id TEXT PK (nanoid) · name TEXT UNIQUE · description TEXT · created_at TEXT

policies      id TEXT PK · agent_id TEXT NULL FK→agents (NULL = global default)
              version INTEGER · active INTEGER (0/1) · rules_json TEXT · created_at TEXT
              -- exactly one active policy per agent_id (enforced in repo layer)

tasks         id TEXT PK · agent_id TEXT FK · intent TEXT NOT NULL
              status TEXT ('active'|'completed'|'expired'|'halted')
              budget_cents INTEGER · spent_cents INTEGER DEFAULT 0 · policy_id TEXT FK
              created_at TEXT · closed_at TEXT NULL
              -- a task has 0..N cards (cards.task_id); no card_id column here

cards         id TEXT PK (upstream card_id, verbatim) · task_id TEXT FK
              amount_cents INTEGER · merchant_hint TEXT NULL · sandbox INTEGER (0/1)
              state TEXT ('open'|'used'|'closed'|'expired') · created_at TEXT · closed_at TEXT NULL
              rail TEXT ('agentcard'|'stripe') NOT NULL DEFAULT 'agentcard'  -- v1.3: which
              -- UpstreamClient issued this card; the reconciler dispatches per-card by rail

transactions  id TEXT PK (AgentCard txn id, verbatim) · card_id TEXT FK
              merchant TEXT · amount_cents INTEGER · currency TEXT · category TEXT NULL
              status TEXT ('PENDING'|'SETTLED'|'DECLINED'|'REVERSED'|'EXPIRED'|'REFUNDED')
              raw_json TEXT · occurred_at TEXT · ingested_at TEXT

receipts      id TEXT PK · transaction_id TEXT UNIQUE FK · task_id TEXT FK
              intent TEXT · policy_id TEXT · decision_json TEXT · created_at TEXT
              -- APPEND-ONLY: no UPDATE/DELETE paths in code

policy_events id TEXT PK · type TEXT ('block'|'circuit_break'|'approval_required'|
              'approved'|'denied'|'card_issued'|'card_closed')
              task_id TEXT NULL FK · agent_id TEXT NULL FK · details_json TEXT · created_at TEXT

approvals     id TEXT PK · task_id TEXT FK · merchant TEXT · amount_cents INTEGER
              reason TEXT · status TEXT ('pending'|'approved'|'denied'|'expired')
              requested_at TEXT · decided_at TEXT NULL · decided_by TEXT NULL
```

### 2.6 Policy rules schema (`rules_json`, zod-validated)

```ts
type PolicyRules = {
  allowed_merchants: string[];        // exact-match merchant names; empty = allow any
  blocked_merchants: string[];
  allowed_categories: string[];       // empty = allow any
  per_card_cap_cents: number;         // clamped to [100, 5000] — upstream hard bounds ($1–$50)
  per_task_budget_cents: number;      // cumulative across all cards in a task
  per_merchant_caps: Record<string, number>;  // merchant → cents (per task)
  velocity: {
    max_cards_per_hour: number;          // issuance velocity; 0 = unlimited
    max_amount_cents_per_day: number;    // 0 = unlimited
  };
  approval_threshold_cents: number;   // >0: card requests above require human approval
  card_ttl_minutes: number;           // Warden-side early close of unused cards (default 60;
                                      // upstream expires unused cards at 7 days regardless)
  default_rail: 'agentcard' | 'stripe';  // v1.3: which UpstreamClient issues cards for this
                                          // policy when warden_issue_card omits `rail`
};
```

### 2.7 Upstream connection (verified against production, 2026-07-07)

- Endpoint: Streamable HTTP MCP at `https://mcp.agentcard.sh/mcp`. **Remote-only; there is no locally spawnable server.**
- Auth: OAuth 2.0 authorization code + PKCE against `https://mcp.agentcard.sh/authorize` and `/token` (discovered via `/.well-known/oauth-authorization-server`; grant types `authorization_code` and `refresh_token`; public client with `token_endpoint_auth_methods` including `none`; dynamic client registration per the MCP auth spec).
- Access tokens are short-lived (~5 minutes observed). The token manager must refresh proactively and treat 401 as refresh-then-retry-once.
- Do **not** copy tokens from `~/.claude.json` or `~/.agent-cards/config.json` — the AgentCard CLI's WorkOS tokens are NOT accepted by the MCP endpoint (verified 401).
- Interactive login happens exactly once, human-driven, via `warden auth` (opens browser, completes PKCE flow, persists tokens). All other code paths must work headlessly with the stored refresh token.
- Known upstream tool constraints (from agentcard.sh/mcp docs): `create_card(amount_cents: 100–5000, sandbox?: boolean)`; cards auto-cancel after one authorized payment; unused cards expire after 7 days; `get_card_details` may require human approval upstream before returning PAN/CVV; `list_transactions(card_id, limit?, status?)`.

### 2.8 Second rail: Stripe Issuing (added v1.3)

`packages/upstream-stripe` implements the same `UpstreamClient` interface (§3.2) against Stripe's Issuing API in test mode, proving the swappable-upstream boundary with a second real rail rather than a second mock. Selected per-card via `rail: 'agentcard' | 'stripe'` on `warden_issue_card` (defaults to the policy's `default_rail`, itself defaulting to `'agentcard'`).

- Endpoint: standard Stripe API (`api.stripe.com`), `STRIPE_SECRET_KEY` (test-mode `sk_test_...`) via env, never committed, never logged.
- Cardholder: one Warden-owned `issuing.cardholders` record created once and cached; all cards are issued under it.
- `createCard`: `issuing.cards.create({ cardholder, type: 'virtual', currency: 'usd', spending_controls: { spending_limits: [{ amount: amount_cents, interval: 'all_time' }] } })`. The `all_time` spending limit is the network-enforced hard cap — Stripe declines any authorization that would exceed it, same guarantee as AgentCard's loaded-balance model.
- **Honest gap vs. AgentCard:** Stripe cards do not auto-cancel after one authorization the way AgentCard's do. Warden's own reconciler closes a Stripe-rail card after its first settled or pending transaction, reproducing single-use semantics operationally rather than natively. The dollar cap is still network-enforced either way; only the "auto-cancel after one charge" behavior is Warden-side for this rail. State this distinction plainly in any pitch or docs — do not imply Stripe natively single-uses cards.
- `closeCard`: `issuing.cards.update(card_id, { status: 'canceled' })`.
- `getCardDetails`: `issuing.cards.retrieve(card_id, { expand: ['number', 'cvc'] })`. Test-mode accounts can retrieve full PAN/CVC for integration-building purposes; this must never be attempted against a live-mode key without the account's PCI review being confirmed first.
- `listTransactions`: merges `issuing.authorizations.list({ card: card_id })` (approved/declined/pending) with `issuing.transactions.list({ card: card_id })` (captured/settled), mapped onto the shared `UpstreamTxnStatus` enum.
- `checkBalance`: computed, not native — the card's `all_time` limit minus the sum of its non-declined authorization amounts. Stripe has no single-card "balance" concept; this is Warden's derived equivalent.
- Test-mode purchase simulation (the Stripe-rail analog of `mock_simulate_purchase`): `stripe.testHelpers.issuing.authorizations.create(...)` then `.capture(...)`. Real network calls against Stripe's sandbox, gated behind `STRIPE_E2E=1`, run by a human — never in CI, mirroring the AgentCard E2E gate in §2.7.

## 3. API / Interface Contracts

### 3.1 warden-mcp tools (exposed to the agent)

All tool args and results are zod-validated. Errors return MCP tool errors with machine-readable `code` values: `POLICY_BLOCKED`, `APPROVAL_REQUIRED`, `APPROVAL_PENDING`, `TASK_NOT_ACTIVE`, `BUDGET_EXCEEDED`, `CIRCUIT_OPEN`, `UPSTREAM_ERROR`, `UPSTREAM_AUTH_REQUIRED`.

```
warden_start_task
  in : { agent_name: string, intent: string, budget_cents?: number }
  out: { task_id, budget_cents, policy_summary: string }
  behavior: resolve agent (create if new) → load active policy → budget = min(requested,
            per_task_budget_cents) → persist task. NO card is minted here.

warden_issue_card
  in : { task_id: string, amount_cents: number, merchant?: string, category?: string,
         rail?: 'agentcard' | 'stripe' }   // v1.3, defaults to policy.default_rail
  out: { card_id, amount_cents, single_use: true, expires: '7d-unused', rail }
  behavior: task must be 'active' → evaluateIssue (per-card cap incl. upstream $1–$50 clamp,
            merchant/category lists, per-merchant caps, remaining task budget, velocity,
            circuit state) → if amount > approval_threshold: create approval, error
            APPROVAL_REQUIRED with approval_id → upstream create_card({amount_cents,
            sandbox: WARDEN_MODE !== 'live'}) → persist card, increment task.spent_cents
            reservation → policy_event card_issued

warden_get_card_details
  in : { card_id: string }
  out: passthrough of upstream get_card_details (PAN/CVV/expiry, in-memory only)
  guard: card must belong to an 'active' task and be 'open'; never persisted or logged

warden_complete_task
  in : { task_id: string }
  out: { task_id, status: 'completed', cards_issued: number, receipts_count: number,
         total_spent_cents: number }
  behavior: upstream close_card for every still-'open' card → mark task completed
            → policy_event card_closed per card → one immediate reconcile pass

warden_precheck_purchase
  in : { task_id: string, merchant: string, amount_cents: number, category?: string }
  out: { decision: 'allow'|'block'|'needs_approval', reasons: string[] }
  behavior: advisory-only deterministic evaluation (never mutates state except policy_event on block)

warden_request_approval
  in : { task_id: string, merchant: string, amount_cents: number, reason: string }
  out: { approval_id, status: 'pending' }

warden_check_approval
  in : { approval_id: string }
  out: { approval_id, status: 'pending'|'approved'|'denied'|'expired',
         card_id?: string }   // on 'approved': a fresh scoped card minted for the approved amount

warden_get_receipts
  in : { task_id?: string, agent_name?: string, limit?: number (default 50) }
  out: { receipts: Array<{id, intent, merchant, amount_cents, category, card_id, occurred_at,
         decision_summary: string}> }
```

Pass-through tools (proxied verbatim to upstream, read-only): `check_balance`, `list_cards`. Checkout mechanics (`buy`, `pay_checkout`, `fill_card`, `detect_checkout`, wallet funding, KYC) are **not** proxied — the agent calls agent-cards directly for those using the card Warden minted. Warden's control point is card issuance and closure, not checkout.

### 3.2 core module contracts (`packages/core`)

```ts
// policy engine — pure, synchronous, no I/O
evaluateIssue(policy: PolicyRules, req: {
  amount_cents: number, merchant?: string, category?: string,
  taskSpentCents: number, taskBudgetCents: number,
  cardsLastHour: number, amountTodayCents: number,
}): IssueDecision
  // IssueDecision = { kind: 'issue', card_amount_cents: number }   // clamped to [100, 5000]
  //               | { kind: 'needs_approval', threshold_cents: number }
  //               | { kind: 'block', reasons: string[] }

evaluatePurchase(policy: PolicyRules, req: {merchant: string, amount_cents: number,
                 category?: string, taskSpentCents: number, taskBudgetCents: number}):
  { decision: 'allow'|'block'|'needs_approval', reasons: string[] }

// circuit breaker — pure
evaluateCircuit(policy: PolicyRules, window: {cardsLastHour: number,
                amountTodayCents: number}): { open: boolean, reasons: string[] }
```

```ts
// packages/upstream — the swappable boundary
interface UpstreamClient {
  createCard(req: {amount_cents: number, sandbox: boolean}): Promise<{card_id: string}>;
  closeCard(card_id: string): Promise<void>;
  getCardDetails(card_id: string): Promise<CardCredentials>;   // never persist
  listTransactions(card_id: string, opts?: {limit?: number, status?: string}): Promise<Txn[]>;
  listCards(): Promise<CardSummary[]>;
  checkBalance(card_id: string): Promise<{balance_cents: number}>;
}
// implementations: RealUpstream (OAuth HTTP) and MockUpstream (in-process, deterministic)
```

### 3.3 warden-api REST endpoints (Hono, JSON)

Auth: `Authorization: Bearer ${WARDEN_API_TOKEN}` on every route except `GET /healthz`.

```
GET  /healthz                          → { ok: true, mode: 'test'|'live', upstream_auth: 'ok'|'needs_login' }
GET  /api/v1/receipts?agent=&task=&limit=&cursor=   → paginated receipts (newest first)
GET  /api/v1/receipts/:id              → single receipt incl. full decision_json + intent
GET  /api/v1/receipts/export           → NDJSON stream of all receipts (audit export)
GET  /api/v1/agents                    → agents with rollup {total_spent_cents, receipts, blocks}
GET  /api/v1/policies?agent=           → active policy (+ version history)
PUT  /api/v1/policies                  → body {agent_name|null, rules: PolicyRules};
                                          creates NEW version, activates it (never mutates old)
GET  /api/v1/approvals?status=pending  → approval queue
POST /api/v1/approvals/:id/decision    → body {decision:'approved'|'denied', decided_by: string}
GET  /api/v1/events?type=&limit=       → policy_events feed
GET  /api/v1/stats                     → { spend_under_management_cents, receipts_total,
                                           blocks_total, avg_blast_radius_cents }
```

`4xx` errors: `{ error: { code: string, message: string } }`. All list endpoints use cursor pagination (`?cursor=<id>`).

### 3.4 Reconciler contract (`packages/mcp`, background loop)

- Every `RECONCILE_INTERVAL_MS` (default 30 000): for each non-`closed` card, call upstream `list_transactions(card_id)`; insert unseen transactions (idempotent on txn id); create one receipt per new non-DECLINED transaction joining the task's intent and the policy decision snapshot; update `tasks.spent_cents` from settled amounts; mark cards `used` when their single authorization settles.
- DECLINED transactions do not create receipts; they create a `block` policy_event annotated `enforced_at: 'network'` — these are the demo-critical "the card said no" moments.
- After each pass, run `evaluateCircuit` per agent — if open, close all that agent's open cards, mark its active tasks `halted`, write `circuit_break` event.
- Cards `open` past `card_ttl_minutes` are closed upstream and marked `expired` locally (upstream would do it at 7 days; Warden tightens it).
- Reconciler failures are logged and retried next tick; they never crash the MCP server. `UPSTREAM_AUTH_REQUIRED` (refresh token dead) sets `/healthz.upstream_auth = 'needs_login'` and surfaces a dashboard banner: "run `warden auth`".

## 4. Implementation Roadmap

Strictly ordered. Each task is single-pass sized, has a clear done-check, and depends only on earlier tasks. Do not reorder. All tasks must pass offline against MockUpstream; only tasks marked **[E2E]** additionally run against the live TEST-mode rail when `AGENTCARD_E2E=1` and stored credentials exist — never in CI, never run interactive auth from code.

Calendar (Ship Season 2026, 6 weeks, ships Aug 16): Week 1 = Jul 13–19 (Phases 0–2, Receipts MVP demo), Week 2 = Jul 20–26 (T11–T12, policy demo), Week 3 = Jul 27–Aug 2 (T13–T14, circuit-breaker demo), Week 4 = Aug 3–9 (Phase 4, approvals + live injection-block demo), Week 5 = Aug 10–13 (T18–T19; T17 only if ahead of schedule), Week 6 = Aug 14–16 (T20–T22, launch). The task order is what matters; the calendar labels where each public weekly demo lands.

**Phase 0 — Skeleton** *(Week 1 · Jul 13–19)*
- **T1. Monorepo scaffold.** pnpm workspace, root tsconfig (strict), packages `core`, `db`, `upstream`, `mock-agentcard`, `mcp`, `api`, `cli`, app `web`, vitest wired, `pnpm build && pnpm test` green with placeholder tests.
- **T2. DB schema + migrations.** Implement §2.5 in drizzle; migration runner; repository module with typed CRUD (incl. "one active policy per agent" invariant and append-only receipts — export no update/delete for receipts). Unit tests.
- **T3. Policy types + engine.** `PolicyRules` zod schema with defaults; `evaluateIssue`, `evaluatePurchase`, `evaluateCircuit` as pure functions per §3.2. Exhaustive unit tests (upstream clamp [100, 5000], caps, allow/block lists, thresholds, budget exhaustion, velocity edges, zero-means-unlimited).

**Phase 1 — Upstream boundary** *(Week 1 · Jul 13–19)*
- **T4. Mock AgentCard server.** `packages/mock-agentcard`: in-process `MockUpstream` implementing §3.2's interface with deterministic behavior — cards auto-cancel after one simulated authorization, $1–$50 clamp, 7-day expiry simulation via injectable clock, scriptable transaction feed (helper: `mock.simulatePurchase(card_id, {merchant, amount_cents})`). This is the test double for everything downstream.
- **T5. OAuth token manager + real client.** `packages/upstream`: PKCE authorization-code flow with dynamic client registration against §2.7's endpoints; token store at `WARDEN_CREDENTIALS_PATH` (JSON file, chmod 600); proactive refresh (refresh when <60s remain), 401 → refresh → retry once → `UPSTREAM_AUTH_REQUIRED`. `RealUpstream` implements the interface over `@modelcontextprotocol/sdk` Streamable HTTP. Unit-test the token manager against a stubbed token endpoint; do not test against production.
- **T6. `warden auth` CLI.** `packages/cli`: `warden auth` opens the browser, runs the PKCE flow via a localhost callback listener, persists tokens, prints the authenticated account; `warden auth --status` shows token state. This is the ONLY interactive code path in the repo. **[E2E]** done-check: human runs it once, `--status` shows a live refresh token.

**Phase 2 — Receipts MVP** *(Week 1 · Jul 13–19 — first public demo)*
- **T7. warden-mcp server: task lifecycle.** MCP server exposing `warden_start_task`, `warden_issue_card`, `warden_get_card_details`, `warden_complete_task` per §3.1 (approval path stubbed: threshold exceeded → `POLICY_BLOCKED` for now). Persist tasks/cards/events. Tests against MockUpstream.
- **T8. Reconciler.** Implement §3.4 minus circuit breaker, against the interface. Done-check offline: mock-simulated purchase produces a receipt row with the intent bound. **[E2E]**: same flow against live TEST mode (sandbox card + sandbox purchase).
- **T9. warden-api: read paths.** Hono server, bearer auth, `/healthz` (incl. upstream_auth), receipts list/detail, agents rollup, stats, events. Serves `apps/web/dist` statically if present.
- **T10. Dashboard v1 — receipts.** Vite React SPA: receipts table (time, agent, merchant, amount, intent, card), receipt detail drawer showing full intent + decision. Token entered once, kept in localStorage. Plain, readable CSS.

**Phase 3 — Policy + containment** *(Weeks 2–3 · Jul 20–Aug 2)*
- **T11. Policy CRUD.** `PUT/GET /api/v1/policies` with versioning per §3.3; wire `warden_issue_card` to the active policy; `warden_precheck_purchase` tool. Tests.
- **T12. Dashboard v2 — policy editor.** Form-based editor for `PolicyRules` (no raw JSON textarea as the primary UI), version history list, per-agent selection.
- **T13. Velocity + circuit breaker.** Finish §3.4: issuance-velocity queries, `evaluateCircuit` wiring, auto close-all + halt on trip, `circuit_break` events surfaced on dashboard with a "resume agent" action. Done-check: mock script issues 40 cards in a minute → circuit opens, cards closed.
- **T14. TTL sweep + blast-radius stat.** Warden-side card TTL auto-close; compute `avg_blast_radius_cents` (mean open-card exposure per task) in `/stats`.

**Phase 4 — Human-in-the-loop** *(Week 4 · Aug 3–9 — injection-block demo week)*
- **T15. Approval service.** `warden_request_approval` / `warden_check_approval`, approvals REST, expiry after `APPROVAL_TTL_MINUTES`; on approve, mint the scoped card capped at the approved amount (still ≤ $50 upstream clamp; larger approved purchases require multiple cards and re-approval per card).
- **T16. Approval notification + UI.** Dashboard approvals queue (approve/deny buttons); optional outbound webhook (`WARDEN_APPROVAL_WEBHOOK_URL`, plain JSON POST). No inbound webhook.

**Phase 5 — Analytics + multi-agent** *(Week 5 · Aug 10–13)*
- **T17. [STRETCH] Categorization + budgets.** Skip unless ahead of schedule; T18 does not depend on it. Deterministic merchant→category mapping table (editable via API), monthly budget per category in policy, burn-down data endpoint, dashboard chart (plain SVG or minimal chart lib).
- **T18. Multi-agent rollup.** Agents page: per-agent policy, spend, receipts, blocks; org totals.

**Phase 6 — Surface area** *(Weeks 5–6 · Aug 10–16)*
- **T19. Audit export.** `/api/v1/receipts/export` NDJSON stream; include intent, consent timestamp (task creation), card amount, policy version — the fields aligned with Visa Rules §4.1.24 record duties. Document the mapping in `docs/audit-mapping.md`.
- **T20. Drop-in SDK.** `packages/sdk`: `withWarden(agentName, intent, async (issueCard) => {...})` — starts task, exposes `issueCard(amount_cents, merchant?)`, completes task in a finally block. Published-shape package (not actually published).
- **T21. Verifiable Intent alignment.** Read the open spec at verifiableintent.dev; add `receipts.vi_json` column via migration storing a Verifiable-Intent-shaped record per receipt; document field mapping in `docs/verifiable-intent.md`. (x402 is out of scope, see §5.)

**Phase 7 — Launch** *(Week 6 · Aug 14–16)*
- **T22. Hardening pass.** Rate-limit API (per-token), zod on every boundary rechecked, `WARDEN_MODE=live` gating (default `test` → every `create_card` gets `sandbox: true`), README quickstart, seed script demoing the full flow against MockUpstream and (optionally, **[E2E]**) live TEST mode.

## 5. Constraint Checklist

**Must not:**
- **Never hold, move, or custody funds.** No wallet funding, no balance transfers. Read-only balance access only. This preserves the no-money-transmitter position.
- **Never store PAN, CVV, or full card credentials.** Persist only the AgentCard `card_id` (and last4/display fields if upstream returns them). `warden_get_card_details` passes credentials through in-memory; nothing card-sensitive is written to SQLite or logs.
- **Never put an LLM/ML call or any external network call in the enforcement path.** Policy evaluation is pure and deterministic. The only network dependency at decision time is the upstream agent-cards MCP.
- **Never rely on software checks as the enforcement mechanism.** Every hard limit must be expressed as `create_card` parameters or `close_card` actions. Assume the agent can bypass Warden's process entirely; the card must still decline. (Cumulative task budgets are enforced at issuance — Warden simply refuses to mint the next card.)
- **Never run interactive auth from library code, tests, or CI.** The browser PKCE flow exists only in `warden auth`. Everything else uses the stored refresh token or fails with `UPSTREAM_AUTH_REQUIRED`.
- **Never copy or reuse tokens from `~/.claude.json` or `~/.agent-cards/config.json`.** The AgentCard CLI's WorkOS tokens are rejected by the MCP endpoint (verified). Warden owns its own OAuth credentials at `WARDEN_CREDENTIALS_PATH`.
- **Never update or delete receipts or policy_events.** Append-only. Policy changes create new versions.
- **No security overclaims in any UI copy, README, or tool descriptions.** Banned words: "unhackable", "fraud detection", "AI security", "injection detection". Approved framing: "guardrails", "receipts", "policy blocked an off-policy purchase".
- **No x402/AP2 integration in this build.** Two card rails (AgentCard, Stripe Issuing) are in scope as of v1.3; broader crypto/mandate rails (x402, AP2) remain a narrative for later.
- **No proxying of checkout tools** (`buy`, `pay_checkout`, `fill_card`, `detect_checkout`). Warden controls issuance/closure only.
- **No external SaaS dependencies** (no hosted DB, no auth provider, no analytics). Single-machine deployable.
- **No test may require network access or live credentials by default.** MockUpstream covers everything; live E2E only under `AGENTCARD_E2E=1`, run by a human.

**Must:**
- Must default to `WARDEN_MODE=test`, which passes `sandbox: true` on every `create_card`; `live` must be set explicitly and is the only mode that omits it.
- Must respect upstream hard bounds: card amounts clamped to 100–5000 cents; assume every card is single-authorization and expires unused at 7 days.
- Must use SQLite (better-sqlite3, WAL mode) as the only datastore; OAuth tokens live in a separate chmod-600 JSON file, never in the DB.
- Must store money as integer cents and timestamps as UTC ISO 8601 strings.
- Must make reconciliation idempotent (transaction ids are upstream ids; inserts are `ON CONFLICT DO NOTHING`).
- Must keep every MCP tool argument and API body zod-validated with typed error codes from §3.1.
- Must call upstream `get_instructions` once at startup when connected (AgentCard requires it for current usage guidance) and log, not act on, its content.
- Must keep each package independently testable; `core` must have zero runtime dependencies beyond zod; everything downstream of the upstream boundary must run against `MockUpstream`.

## 6. Dependencies

**Runtime / tooling**
- Node.js ≥ 22, pnpm ≥ 9, TypeScript ≥ 5.5 (strict mode)

**Libraries**
- `@modelcontextprotocol/sdk` — MCP server (to agent) and Streamable HTTP client (to agent-cards)
- `zod` — all boundary validation
- `better-sqlite3`, `drizzle-orm`, `drizzle-kit` — persistence + migrations
- `hono`, `@hono/node-server` — REST API + static serving
- `react`, `react-dom`, `vite`, `@vitejs/plugin-react` — dashboard SPA
- `open` — launch browser in `warden auth` (CLI only)
- `nanoid` — ids for Warden-owned rows
- `vitest` — tests
- (dev) `eslint`, `prettier`
- `stripe` — Stripe Node SDK, `upstream-stripe` only (v1.3)

**External services**
- AgentCard MCP — `https://mcp.agentcard.sh/mcp`, remote-only, OAuth 2.0 + PKCE (§2.7). TEST mode (sandbox flag) for all development and demos.
- Stripe Issuing — `api.stripe.com`, test-mode secret key (§2.8), added v1.3 as the second rail.
- Optional: any webhook receiver (Slack incoming webhook, ntfy) for approval notifications.

**Environment variables**
| Var | Required | Default | Purpose |
|---|---|---|---|
| `AGENTCARD_MCP_URL` | no | `https://mcp.agentcard.sh/mcp` | Upstream agent-cards MCP endpoint (Streamable HTTP; remote-only) |
| `WARDEN_CREDENTIALS_PATH` | no | `~/.warden/credentials.json` | OAuth token store written by `warden auth` (chmod 600) |
| `WARDEN_MODE` | no | `test` | `test` (sandbox flag on every card) or `live` (real money) |
| `WARDEN_DB_PATH` | no | `./warden.db` | SQLite file path |
| `WARDEN_API_TOKEN` | yes | — | Bearer token for warden-api and dashboard |
| `WARDEN_APPROVAL_WEBHOOK_URL` | no | — | Outbound JSON POST on new approval request |
| `RECONCILE_INTERVAL_MS` | no | `30000` | Reconciler poll interval |
| `APPROVAL_TTL_MINUTES` | no | `60` | Pending approvals expire after this |
| `AGENTCARD_E2E` | no | — | Set to `1` to enable live TEST-mode E2E tests against AgentCard (human-run only) |
| `STRIPE_SECRET_KEY` | no | — | Test-mode Stripe secret key; required only when `rail=stripe` is used or `STRIPE_E2E=1` (v1.3) |
| `STRIPE_E2E` | no | — | Set to `1` to enable live test-mode E2E tests against Stripe Issuing (human-run only, v1.3) |
| `PORT` | no | `8787` | warden-api listen port |
