# Warden — Build Status

Updated: 2026-07-18 · Ship Season Week 1 · 12 commits · 88 tests green

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
| 2 · Jul 20–26 | T11 policy CRUD REST + `warden_precheck_purchase` (engine already wired to issuance) · T12 dashboard policy editor | "My agent can only spend $X at approved merchants" |
| 3 · Jul 27–Aug 2 | T13 circuit breaker wired into reconciler (auto close-all + halt + resume UI) · T14 card TTL sweep (blast-radius stat already done) | "40 charges in a minute → frozen" |
| 4 · Aug 3–9 | T15 approval service (replaces stub) · T16 approvals UI + webhook · live injection demo on real sandbox (needs KYC) | The viral moment |
| 5 · Aug 10–13 | T18 multi-agent dashboard page (API rollup exists) · T17 category budgets [STRETCH] | "Which of my agents spent what" |
| 6 · Aug 14–16 | T19 NDJSON audit export + Visa §4.1.24 mapping doc · T20 `withWarden` SDK · T21 Verifiable Intent records · T22 hardening (rate limit, live-mode gating) · landing page, pricing, waitlist | Launch |

## Operational notes

- Demo reset order: **kill server → rm db → start server → refresh browser →
  run agent**. Deleting the db under a running server serves stale data.
- Dashboard token lives in browser localStorage (`warden_api_token`); clear
  with `localStorage.removeItem('warden_api_token')` to see the gate again.
- Demo run: `node packages/mcp/dist/demo-agent.js ./warden-demo.db --fresh`,
  then `WARDEN_API_TOKEN=demo-token WARDEN_DB_PATH=./warden-demo.db node
  packages/api/dist/main.js` → http://localhost:8787.
