# Warden

Warden is the operator authority layer for AI-agent spending. Before an agent can pay, a
human creates an immutable mandate naming the delegate, purpose, payee, total budget,
per-purchase ceiling, use count, payment rail, and expiry. Warden turns that authority into
atomic single-use card reservations and hash-linked settlement evidence.

**Every agent dollar starts with your decision.**

## How it works

```
Agent ──MCP──▶ warden-mcp (policy + proxy) ──MCP/OAuth──▶ agent-cards
                    │                                        ▲
                    ▼                                        │
                SQLite ◀── reconciler (polls transactions) ──┘
                    ▲
              warden-api (Hono) ◀── dashboard (React)
```

- **warden_list_my_mandates** — a bound agent discovers only authority delegated to it
- **warden_start_mandate_task** — opens one active operator-approved mandate
- **warden_issue_card** — atomically reserves authority and mints one single-use card
- **warden_get_card_details** — pass-through PAN/CVV for open cards (never persisted)
- **reconciler** — turns rail outcomes into append-only, hash-linked evidence

`warden_start_task` and `warden_complete_task` remain compatibility tools for the older
self-declared workflow. They are disabled by default and require
`WARDEN_ALLOW_LEGACY_TASKS=true`.

Amount caps are enforced by the issuing rail. Payee intent is checked before issuance and
verified against the observed merchant at settlement; network-level merchant binding depends
on the selected rail's capabilities. The policy engine is deterministic, and Warden never
holds funds or stores PAN/CVV.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test          # all offline, runs against the in-process mock upstream

# one-time interactive AgentCard login (the only interactive step)
node packages/cli/dist/cli.js auth
node packages/cli/dist/cli.js auth --status

# run one identity-bound MCP proxy per delegated agent (stdio)
WARDEN_AGENT_NAME=procurement-agent WARDEN_DB_PATH=./warden.db node packages/mcp/dist/main.js

# run the API + dashboard
WARDEN_API_TOKEN=<pick-a-token> WARDEN_OPERATOR_NAME="Your name" \
  WARDEN_DB_PATH=./warden.db node packages/api/dist/main.js
# open http://localhost:8787 and enter the token
```

Sandbox by default: `WARDEN_MODE=test` (the default) passes `sandbox: true` on every card.
Create and activate a mandate in the dashboard. The bound agent can then call
`warden_list_my_mandates`, select the relevant authority, and call
`warden_start_mandate_task` without an operator copying database IDs into a prompt.

### Offline demo (no credentials needed)

For the VC-ready proof console with a fresh deterministic dataset:

```bash
pnpm demo
# open the printed URL; the token is applied automatically
```

This single command rebuilds the product, resets a demo-only database under
`/private/tmp`, seeds approved settlements plus a prevented out-of-scope request,
and starts the dashboard. The full mandate registry, evidence ledger, and policy
editor remain available behind the proof-first overview.

The demo drives the mandate-first workflow over stdio exactly like a real agent's MCP client
(same identity binding, discovery, tools, and errors) against the in-process mock rail:

```bash
# terminal 1 — dashboard (choose an unused database path for each run)
WARDEN_API_TOKEN=demo-token WARDEN_DB_PATH=/private/tmp/warden-demo-01.db \
  node packages/api/dist/main.js

# terminal 2 — narrated run: operator mandate → agent discovery → authorization
# → settlement evidence → injected purchase blocked before a card exists
node packages/mcp/dist/demo-agent.js /private/tmp/warden-demo-01.db
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
      "env": {
        "WARDEN_DB_PATH": "/path/to/warden/warden.db",
        "WARDEN_AGENT_NAME": "procurement-agent"
      }
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

Full technical spec: [SPEC.md](./SPEC.md). Warden is an authority, control, and evidence
layer—not fraud detection and not an “unhackable” payment network. The current local operator
identity and SHA-256 evidence chain are suitable for an MVP/demo; production deployments
should add organizational authentication, managed signing keys, multi-tenant isolation,
webhook-first settlement, idempotent/recoverable rail provisioning, and external evidence
anchoring.

Investor preparation: [VC meeting brief](./docs/VC_MEETING_BRIEF.md) ·
[five-minute demo runbook](./docs/VC_DEMO_RUNBOOK.md)
