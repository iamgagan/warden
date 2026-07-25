# Warden VC Demo Runbook

The objective is to show one complete story in under five minutes:

> A human grants exact authority, the correct agent discovers and uses it, Warden records the
> outcome, and an injected out-of-scope purchase receives no credential.

## Preflight

- Use Node.js 22 or newer.
- Keep `STRIPE_SECRET_KEY` unset for the deterministic mock-rail demo.
- Choose a new database path for every meeting; do not delete a database under a running
  server.
- Close unrelated terminals and browser tabs.
- Keep the dashboard at a desktop width of at least 1200 px.
- Do not call the demo “production,” “unhackable,” or “merchant-enforced at the network.”

Build and verify:

```bash
pnpm build
pnpm test
```

Expected result: the production build succeeds and all tests pass.

## Start the dashboard

Choose a fresh path, for example:

```bash
WARDEN_API_TOKEN=demo-token \
WARDEN_OPERATOR_NAME="Gagan Singh" \
WARDEN_DB_PATH=/private/tmp/warden-vc-demo-01.db \
node packages/api/dist/main.js
```

Open [http://localhost:8787](http://localhost:8787) and enter `demo-token`.

The initial empty state is useful: it makes clear that the records are not a static mockup.

## Run the real MCP flow

In a second terminal, using the same database path:

```bash
node packages/mcp/dist/demo-agent.js /private/tmp/warden-vc-demo-01.db
```

This script:

1. creates and activates an operator mandate through the real repository lifecycle;
2. launches `warden-mcp` over stdio with `WARDEN_AGENT_NAME=procurement-agent`;
3. discovers the mandate through `warden_list_my_mandates`;
4. opens it through `warden_start_mandate_task`;
5. prechecks and issues a bounded, idempotent card;
6. settles a mock-rail transaction through the reconciler;
7. appends verified evidence;
8. attempts an out-of-scope gift-card purchase and receives no card.

The dashboard polls automatically. Navigate between Overview, Mandates, and Evidence while the
terminal advances.

## Five-minute talk track

### 0:00–0:35 — Problem

“Agents can already reach checkout. The missing primitive is not another card—it is a
defensible answer to who authorized this agent, for what purpose, with which limits, and what
actually happened.”

### 0:35–1:20 — Operator authority

Show the mandate:

- delegate: `procurement-agent`;
- purpose: printer paper for the New York office;
- payee: Staples;
- total authority: $40;
- per-purchase limit: $25;
- expiry: 24 hours.

“Once activated, these terms are immutable. To change them, the operator revokes and creates
new authority.”

### 1:20–2:15 — Agent discovery and execution

Point to the terminal:

“The agent does not declare its own identity or budget. Its MCP process is identity-bound, it
discovers only mandates delegated to it, and it uses an idempotency key so retries cannot
double reserve or double mint.”

When the card is issued:

“Warden atomically reserves authority before provisioning a single-use credential. The
underlying rail enforces the amount ceiling.”

### 2:15–3:10 — Evidence

Open Evidence and select the newest record:

“The rail-observed settlement is checked against the original mandate and authorization.
Warden seals the record into a recomputed SHA-256 chain. This is local tamper evidence today;
managed signatures and external anchoring are production roadmap work.”

### 3:10–3:50 — Failure moment

Let the terminal attempt `sketchy-gift-cards.example`:

“The page changed the requested merchant, but the operator’s authority did not change. Warden
created no card and consumed no authority.”

### 3:50–4:35 — Positioning

“Visa, Mastercard, Stripe, Ramp, AgentCard, and Lithic are building networks, tokens, wallets,
cards, and finance suites. Warden is the neutral layer above them: one operator mandate,
capability-aware enforcement across rails, and one evidence model.”

### 4:35–5:00 — Honest next milestone

“This is a local MVP. The next milestone is a design partner executing payee-bound production
transactions through an AP2-compatible signed mandate, webhook-first settlement, and
organization-backed identity.”

## Claims to make

- “The current implementation is mandate-first.”
- “Legacy self-declared spending is disabled by default.”
- “Amount reservations are atomic and retries are idempotent.”
- “The same authority model supports multiple payment rails.”
- “Evidence integrity is recomputed on read and visibly fails after tampering.”
- “The demo exercises the real MCP transport, repository, reconciler, API, and dashboard.”

## Claims not to make

- Do not say the current rails prevent spending at the wrong merchant.
- Do not call the local operator name cryptographic identity.
- Do not call a local hash chain an independent signature or external proof.
- Do not say revocation is instantaneous at the network.
- Do not say provisioning is crash-safe.
- Do not present seeded or mock settlement volume as customer traction.

## Recovery

- If the dashboard has old data, stop the API and choose a new database filename.
- If port 8787 is busy, set `PORT=8788` and open that port.
- If the terminal cannot find the mandate, confirm both commands use the same database path.
- If the browser does not refresh immediately, wait for the five-second poll or reload once.
- If a demo run is interrupted, use a new database filename rather than mutating the old run.

## Optional seeded browsing dataset

For a fuller dashboard after the live story:

```bash
node scripts/seed-demo.mjs /private/tmp/warden-vc-browse.db
WARDEN_API_TOKEN=demo-token \
WARDEN_OPERATOR_NAME="Gagan Singh" \
WARDEN_DB_PATH=/private/tmp/warden-vc-browse.db \
node packages/api/dist/main.js
```

This dataset is for visual browsing only. Lead with the real MCP flow above.
