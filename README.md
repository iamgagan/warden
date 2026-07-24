# Warden

Spend guardrails + audit receipts for AI agents that pay with virtual cards, built on the
[AgentCard](https://agentcard.sh) MCP. Humans set budgets and rules; Warden enforces them by
minting single-use scoped cards ($1–$50, auto-cancel after one authorization) so hard limits
live at the card network, and binds every charge to the agent's triggering intent as an
append-only receipt.

Every dollar, with the why.

## How it works

```
Agent ──MCP──▶ warden-mcp (policy + proxy) ──MCP/OAuth──▶ agent-cards
                    │                                        ▲
                    ▼                                        │
                SQLite ◀── reconciler (polls transactions) ──┘
                    ▲
              warden-api (Hono) ◀── dashboard (React)
```

- **warden_start_task** — agent declares its intent and gets a budget envelope
- **warden_issue_card** — one single-use card per purchase, deterministically policy-checked
- **warden_get_card_details** — pass-through PAN/CVV for open cards (never persisted)
- **warden_complete_task** — closes open cards, releases unused budget

Declines happen at the card network, not in software an agent can route around. The policy
engine is pure and deterministic; no ML in the enforcement path. Warden never holds funds.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test          # all offline, runs against the in-process mock upstream

# one-time interactive AgentCard login (the only interactive step)
node packages/cli/dist/cli.js auth
node packages/cli/dist/cli.js auth --status

# run the MCP proxy your agent connects to (stdio)
WARDEN_DB_PATH=./warden.db node packages/mcp/dist/main.js

# run the API + dashboard
WARDEN_API_TOKEN=<pick-a-token> WARDEN_DB_PATH=./warden.db node packages/api/dist/main.js
# open http://localhost:8787 and enter the token
```

Sandbox by default: `WARDEN_MODE=test` (the default) passes `sandbox: true` on every card.

### Offline demo (no credentials needed)

The demo agent drives warden-mcp over stdio exactly like a real agent's MCP client
(same transport, same tools, same errors) against the in-process mock rail:

```bash
# terminal 1 — dashboard
node packages/mcp/dist/demo-agent.js ./warden-demo.db --fresh   # creates the db, exits
WARDEN_API_TOKEN=demo-token WARDEN_DB_PATH=./warden-demo.db node packages/api/dist/main.js

# terminal 2 — narrated agent run: task → card → purchase → receipt → injected
# purchase blocked (POLICY_BLOCKED, no card ever minted) → task complete
node packages/mcp/dist/demo-agent.js ./warden-demo.db --fresh
```

`scripts/seed-demo.mjs` seeds a richer multi-agent dataset for dashboard browsing.

### Second rail: Stripe Issuing (test mode)

Set `STRIPE_SECRET_KEY` (a test-mode `sk_test_...` key with Issuing enabled) before running
warden-mcp or the demo agent, and `warden_issue_card` can mint on either rail via
`rail: 'agentcard' | 'stripe'` (defaults to the policy's `default_rail`). With the key set, the
demo agent's step ④ mints a real Stripe Issuing test-mode card and drives a real network
authorization against Stripe's sandbox — same policy engine, same receipt schema, a different
card network. See [SPEC §2.8](./SPEC.md#28-second-rail-stripe-issuing-added-v13) for the exact
API shapes and the honest gap (Stripe cards don't auto-cancel after one authorization the way
AgentCard's do; Warden's reconciler closes them operationally instead).

`STRIPE_SECRET_KEY=sk_test_... node scripts/e2e-stripe.mjs` runs a human-triggered live check
against the real Stripe sandbox (never CI), mirroring `scripts/e2e-real.mjs` for AgentCard.

### Point an agent at Warden

```json
{
  "mcpServers": {
    "warden": {
      "command": "node",
      "args": ["/path/to/warden/packages/mcp/dist/main.js"],
      "env": { "WARDEN_DB_PATH": "/path/to/warden/warden.db" }
    }
  }
}
```

## Packages

| Package | Purpose |
|---|---|
| `@warden/core` | policy types + pure deterministic policy engine |
| `@warden/db` | SQLite (drizzle) schema, migrations, repositories |
| `@warden/upstream` | OAuth 2.0 + PKCE token manager, real agent-cards MCP client |
| `@warden/mock-agentcard` | deterministic in-process upstream for tests and demos |
| `@warden/upstream-stripe` | second rail: `UpstreamClient` over Stripe Issuing (test mode) |
| `@warden/mcp` | warden-mcp server (proxy + policy gate) + reconciler |
| `@warden/api` | warden-api REST server, serves the dashboard |
| `@warden/cli` | `warden auth` (interactive login) |
| `apps/web` | receipts dashboard (Vite + React) |

Full technical spec: [SPEC.md](./SPEC.md). Built in public for Ship Season 2026, shipping
Aug 16. Framing note: Warden is guardrails + receipts, not fraud detection and not
"unhackable" — dollar caps are network-enforced; merchant/category rules are enforced
deterministically at issuance with blast radius bounded by single-use cards.
