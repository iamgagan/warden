# Warden — Current Status

Updated: 2026-07-24 · mandate-first local MVP · 136 automated tests passing

## Product direction

Warden is now an **operator authority and evidence control plane for agent spending**.

The primary workflow is:

```text
operator mandate
  → identity-bound agent discovery
  → atomic authorization reservation
  → bounded rail credential
  → rail-observed outcome
  → verified evidence
```

The older model-created task/budget flow is compatibility-only and disabled by default.

## Implemented

### Authority

- Draft, active, exhausted, revoked, and expired mandate lifecycle
- Immutable terms after activation
- Delegate, purpose, exact payee, total budget, per-purchase ceiling, maximum uses, rail,
  policy snapshot, approver, and expiry
- Operator create/activate/revoke REST APIs
- Process-bound MCP agent identity through `WARDEN_AGENT_NAME`
- Agent-scoped `warden_list_my_mandates` discovery
- Mandate-controlled task lifecycle

### Authorization and accounting

- Required idempotency key for mandate purchases
- Atomic cumulative-budget and use-count reservation
- Same-key retry safety, including concurrent in-flight requests
- Safe release after provisioning failure
- Unicode-aware merchant normalization
- Multi-rail routing through AgentCard and Stripe Issuing test mode
- Card-wide cumulative settlement true-up for multiple captures
- Pending-to-settled lifecycle polling
- Late settlement preservation across revocation and expiry
- Stripe authorization/capture normalization into one logical transaction

### Evidence

- Append-only mandate outcome events
- Checks for payee, authorization amount, and rail binding
- Hash-linked sequence across records
- Full evidence envelope and display facts included in the hash
- Chain recomputed on every evidence read
- Visible verification failure after payload tampering
- Rail-native payload retained without exposing PAN/CVV

### Operator product

- Responsive overview, mandate registry, evidence ledger, and policy editor
- Create-and-activate mandate flow with advanced controls
- Irreversible revocation confirmation with recorded reason
- Loading, error, empty, and mobile states
- Honest explanation of amount enforcement versus settlement-time payee verification
- Rich deterministic seed dataset

### Demonstration

- `packages/mcp/src/demo-agent.ts` runs the mandate-first path over real MCP stdio
- The demo uses identity-bound discovery, idempotent issuance, mock settlement, evidence
  creation, and an out-of-scope prompt-injection attempt
- `docs/VC_DEMO_RUNBOOK.md` contains the five-minute choreography and recovery steps
- `docs/VC_MEETING_BRIEF.md` contains the market map, product verdict, roadmap, and likely VC
  questions

## Verification

- `pnpm build` passes for every workspace package and the production web bundle.
- `pnpm test` passes 136/136 tests across 10 test files.
- Desktop and mobile browser flows were exercised against the real local API.
- Browser console produced no errors or warnings during the verified run.
- Create, activate, list, revoke, evidence-detail, policy, empty, loading, and responsive
  states were inspected.
- The deterministic demo seed completes against the built packages.
- Two independent fixed-point reviews found no remaining local-MVP correctness or security
  blockers.

## Production gaps

These are explicitly outside the local MVP and must be resolved before real-money deployment:

1. **Payee enforcement:** current rails enforce amount; payee is checked before issuance and
   verified at settlement. Add a merchant-bound issuer control or real-time authorization
   callback.
2. **Provisioning recovery:** add upstream idempotency, provisioning leases, and orphan-card
   discovery around the external card-creation call.
3. **Confirmed revocation:** expose `revoking` until the rail confirms credential closure.
4. **Organizational identity:** replace local operator/token and process-name identity with
   organizations, roles, agent sponsors, scoped credentials, and managed signing keys.
5. **Protocol portability:** implement AP2-compatible signed mandate import/export.
6. **Event delivery:** move from polling-first to verified webhook-first ingestion with polling
   as recovery.
7. **External evidence:** add managed signatures, export, and optional external anchoring.

## Next milestones

### Customer proof

- Interview 20 agent-platform and procurement-automation builders.
- Secure 3–5 design partners with a named workflow and technical owner.
- Validate that multi-rail authority portability is painful enough to buy.

### Production authorization

- Select one rail with merchant-bound authorization.
- Add organization-backed identity and AP2 mandate mapping.
- Ship crash-safe provisioning and webhook settlement.
- Execute repeated design-partner transactions outside a founder-operated demo.

### Distribution

- Package Warden as an SDK/MCP integration for agent platforms.
- Add finance/audit exports and at least one workflow-system integration.
- Measure weekly active agents, mandates, authorization outcomes, recovery rate, and settled
  spend with complete evidence.

## Local demo

Build and verify:

```bash
pnpm build
pnpm test
```

Start the dashboard against a fresh database path:

```bash
WARDEN_API_TOKEN=demo-token \
WARDEN_OPERATOR_NAME="Gagan Singh" \
WARDEN_DB_PATH=/private/tmp/warden-vc-demo-01.db \
node packages/api/dist/main.js
```

Run the mandate-first MCP flow in another terminal:

```bash
node packages/mcp/dist/demo-agent.js /private/tmp/warden-vc-demo-01.db
```

Open [http://localhost:8787](http://localhost:8787) and enter `demo-token`.
