# Warden — Build Status

Updated: 2026-07-25 · T11/T12 done + multi-rail pivot ahead of investor demo · 109 tests green

## Done — Week 1: Receipts MVP (T1–T10)

- **T1** Monorepo: pnpm workspace, strict TS, vitest, 7 packages + web app
- **T2** SQLite schema (drizzle), migration runner, repos with invariants
  (one active policy per agent, append-only receipts)
- **T3** Deterministic policy engine (`evaluateIssue` / `evaluatePurchase` /
  `evaluateCircuit`), 25 tests incl. upstream clamp and velocity edges
- **T4** MockUpstream: single-use auto-cancel, $1–$50 clamp, injectable-clock
  7-day expiry, scriptable purchases
- **T5** OAuth PKCE token manager (proactive refresh, 401 → refresh → retry
  once), RealUpstream over MCP Streamable HTTP
- **T6** `warden auth` CLI — **done-check passed live 2026-07-17**: refresh
  token stored at `~/.warden/credentials.json`
- **T7** warden-mcp tools: start_task, issue_card, get_card_details,
  complete_task (approval path stubbed as POLICY_BLOCKED until T15)
- **T8** Reconciler: settlements → intent-bound receipts; declines →
  `enforced_at: network` block events; done-check passing offline
- **T9** warden-api: healthz, receipts list/detail, agents rollup, events,
  stats; bearer auth; serves the dashboard build
- **T10** Receipts dashboard: stats strip, receipts table, intent drawer,
  token in localStorage (`#token=` hash handoff for demos)

Extras beyond plan: narrated demo agent (`packages/mcp/dist/demo-agent.js`,
real stdio MCP client + `WARDEN_UPSTREAM=mock` server mode with demo-only
`mock_simulate_purchase` tool), `scripts/seed-demo.mjs`, `scripts/e2e-real.mjs`,
README quickstart.

## Live-rail findings (first real E2E, 2026-07-17 — all fixed & committed)

1. Access tokens die in ~5 min despite `expires_in` claiming 24 h → lifetime
   assumption capped at 5 min; 401 retry path covers the rest.
2. MCP SDK 401s say "Invalid or expired token" (no literal "401") →
   `isAuthFailure` now checks the error's `code` and that message.
3. agent-cards returns `structuredContent` + prose text → client now prefers
   the structured payload.
4. Business statuses (`kyc_required`, `wallet_funding_required`, …) arrive as
   successful results with a `status` field → surfaced as clean errors.

## Done — Week 2: Policy CRUD + Dashboard Editor (T11–T12, 2026-07-25)

- **T11** `GET/PUT /api/v1/policies` (versioned, agent-scoped or global default — the repo
  layer's `setActivePolicy`/`getActivePolicy`/`listPolicyVersions` already enforced "exactly
  one active version, never mutates old" from T2, this just wired REST on top) · zod-validated
  via the same `PolicyRulesSchema` used everywhere else · `warden_precheck_purchase` MCP tool
  (advisory-only `evaluatePurchase`, never mints a card, writes a policy_event only on block).
  15 API tests, 4 new precheck tests.
- **T12** Dashboard policy editor: per-agent selector (falls back to global default), form
  fields for every `PolicyRules` key incl. per-merchant caps (add/remove rows) and the new
  `default_rail` selector — no raw JSON textarea — plus a version-history table. Live-verified
  end to end in the browser: edited shopping-agent's real policy (budget $80→$40, added
  `allowed_merchants: ["Staples"]` and a `Staples: $25` merchant cap), saved, confirmed via the
  API that it landed as version 2 with version 1 correctly marked superseded and untouched
  fields (`blocked_merchants`) round-tripped intact.

Demo target hit: "my agent can only spend $X at approved merchants" is real — editable in the
dashboard, enforced by the same deterministic engine that's been live since Week 1.

## Multi-rail pivot (2026-07-24, ahead of Monday investor demo)

Added a second real `UpstreamClient` — `@warden/upstream-stripe`, over Stripe Issuing test
mode — alongside AgentCard, to back the "rail-agnostic policy + receipt layer" pitch framing
with real code instead of just an architectural claim. SPEC.md bumped to v1.3 (§2.8 documents
the rail; §5's "only rail is AgentCard" constraint relaxed). `cards.rail` column added;
`warden_issue_card` takes an optional `rail` param (defaults to the policy's `default_rail`);
reconciler dispatches per-card by rail. Dashboard shows a rail badge per receipt. Demo agent's
step ④ mints a real Stripe test-mode card and drives a real sandbox authorization when
`STRIPE_SECRET_KEY` is set — same task, same policy engine, same receipt schema, a different
card network. 99/99 offline tests green; live-verified against both real rails (AgentCard via
the pre-existing `scripts/e2e-real.mjs`, Stripe via the new `scripts/e2e-stripe.mjs`).

**Honest gap, stated plainly (also in SPEC §2.8 and the README):** Stripe Issuing cards don't
auto-cancel after one authorization the way AgentCard's do. The dollar cap is still
network-enforced by Stripe's `spending_limits` either way — only the "auto-cancel after one
charge" behavior is Warden-side (the reconciler closes the card once its first non-declined
authorization lands) rather than a native upstream guarantee for this rail.

### Live-rail findings (Stripe Issuing, first real E2E, 2026-07-24 — all fixed & committed)

1. Cardholder creation needs `individual.first_name` / `last_name` / `dob` /
   `card_issuing.user_terms_acceptance` — a flat `name` field alone leaves the cardholder unable
   to activate any card ("outstanding requirements").
2. Every new/updated cardholder goes under automated review
   (`requirements.disabled_reason: 'under_review'`); until it clears — normally a few seconds —
   every authorization on their cards declines with `cardholder_verification_required`
   regardless of spending limits → `StripeUpstream` now polls the cardholder after creation and
   waits for review to clear (bounded, proceeds either way) before returning.
3. A live timestamp (`Date.now()`) inside a payload sent under a fixed idempotency key breaks
   idempotency on the very next process start, since Stripe requires byte-identical params to
   reuse a key → the cardholder's `user_terms_acceptance.date` is now a fixed constant.
4. `issuing.transactions.amount` is signed by ledger convention (negative = money left the
   balance, i.e. a capture) — a settled $18.99 purchase reported as `-1899` → mapped through
   `Math.abs()` since Warden's `amount_cents` is always a magnitude, never signed.

## Blockers (human-only)

- [ ] **KYC on the AgentCard account** — required before creating any card,
  sandbox included (government ID + face scan). Needed before the Week 4
  live-injection demo. After KYC: rerun `node scripts/e2e-real.mjs`.
- [ ] **Push repo to GitHub** — everything committed locally; form needs the URL.
- [ ] **Record + upload the Week 2 video** — script and demo choreography in
  `Warden-Week2-Form-Answers.pdf`; say "test mode against a simulated card
  rail", not "sandbox", until KYC is done.

## Remaining roadmap

| Week | Tasks | Demo |
|---|---|---|
| ~~2 · Jul 20–26~~ | ~~T11 policy CRUD REST + `warden_precheck_purchase`~~ · ~~T12 dashboard policy editor~~ — **done 2026-07-25** | "My agent can only spend $X at approved merchants" ✅ |
| 3 · Jul 27–Aug 2 | T13 circuit breaker wired into reconciler (auto close-all + halt + resume UI) · T14 card TTL sweep (blast-radius stat already done) | "40 charges in a minute → frozen" |
| 4 · Aug 3–9 | T15 approval service (replaces stub) · T16 approvals UI + webhook · live injection demo on real sandbox (needs KYC) | The viral moment |
| 5 · Aug 10–13 | T18 multi-agent dashboard page (API rollup exists) · T17 category budgets [STRETCH] | "Which of my agents spent what" |
| 6 · Aug 14–16 | T19 NDJSON audit export + Visa §4.1.24 mapping doc · T20 `withWarden` SDK · T21 Verifiable Intent records · T22 hardening (rate limit, live-mode gating) · landing page, pricing, waitlist | Launch |

## Operational notes

- Demo reset order: **kill server → rm db → start server → refresh browser →
  run agent**. Deleting the db under a running server serves stale data.
- The dashboard's own poll loop refreshes every 5s — no manual browser refresh needed once
  it's open while the demo agent runs, but a hard reload (cmd+shift+r) is worth doing right
  before a live demo in case a stale bundle/old drawer state is cached from a prior session.
- For the dual-rail step: `export STRIPE_SECRET_KEY=sk_test_...` (test-mode, Issuing enabled,
  some test funds added to the Issuing balance) before running the demo agent or warden-mcp.
  Without it, step ④ prints a one-line skip notice and the rest of the demo runs unaffected.
- Dashboard token lives in browser localStorage (`warden_api_token`); clear
  with `localStorage.removeItem('warden_api_token')` to see the gate again.
- Demo run: `node packages/mcp/dist/demo-agent.js ./warden-demo.db --fresh`,
  then `WARDEN_API_TOKEN=demo-token WARDEN_DB_PATH=./warden-demo.db node
  packages/api/dist/main.js` → http://localhost:8787.
