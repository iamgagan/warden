# Warden VC Meeting Brief

Updated: July 24, 2026

## Bottom line

Warden is a promising product if it becomes the **neutral authorization and evidence control
plane for agent spending**. It is not compelling enough as another virtual-card wrapper,
policy editor, or receipt dashboard; well-funded payment networks, issuers, and finance
platforms already own those layers.

The strongest one-line pitch is:

> Warden turns a human decision into bounded, portable authority an AI agent can execute
> across payment rails—and proves exactly what happened afterward.

The current product is a credible local MVP and investor demonstration. It proves the control
loop, but it is not ready for real-money production or evidence of product-market fit.

## Why this is a real market now

- Google’s AP2 makes typed intent and payment mandates a first-class part of agent payments,
  including merchant scope, limits, expiry, authorization, and receipts. That strongly
  validates Warden’s move from generic policy to mandates.
  [Google’s developer guide](https://developers.googleblog.com/en/developers-guide-to-ai-agent-protocols/)
  and the [AP2 reference repository](https://github.com/google-agentic-commerce/AP2) are the
  most direct standards signals.
- Visa reports that agentic commerce is moving from experiments into live activity and frames
  authorization and accountability as unresolved ecosystem questions.
  [Visa’s July 2026 analysis](https://www.visa.com/en-us/thought-leadership/innovation/agentic-payments-from-the-ground-up)
  and its [production-pilot update](https://usa.visa.com/about-visa/newsroom/press-releases.releaseId.21961.html)
  show the networks are actively shaping the category.
- Mastercard is taking agent identity and permissioning into network infrastructure through
  Agent Pay and Agent Pay for Machines.
  [Mastercard Agent Pay](https://www.mastercard.com/us/en/news-and-trends/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai.html)
  and [Agent Pay for Machines](https://investor.mastercard.com/investor-news/investor-news-details/2026/Mastercard-Launches-Agent-Pay-for-Machines-to-Unlock-Super-Fast-Always-On-Payments/default.aspx)
  validate the need while also showing that network-native competition will be formidable.
- Stripe now supports scoped payment tokens, agent wallets, network agentic-payment programs,
  and merchant-side agentic commerce. This makes “we issue a one-time card for agents” an
  insufficient standalone thesis.
  [Stripe’s Shared Payment Token expansion](https://stripe.com/blog/supporting-additional-payment-methods-for-agentic-commerce)
  and [2026 product announcements](https://stripe.com/newsroom/news/sessions-2026) illustrate
  how quickly payment primitives are becoming platform features.

The market signal is strong. The strategic implication is equally important: Warden should
sit **above and between** these systems, not try to replace them.

## Competitive map

| Layer | Representative products | What they own | Implication for Warden |
|---|---|---|---|
| Protocol | Google AP2 | Portable mandate vocabulary and payment proof | Implement and extend it; do not invent an isolated schema |
| Networks | Visa Intelligent Commerce, Mastercard Agent Pay | Network trust, tokens, identity, authorization | Partner/compile to them; do not claim network-level enforcement without it |
| Commerce/payment platform | Stripe Agentic Commerce Suite and Link agent wallets | Merchant acceptance, wallets, scoped tokens | Warden must remain useful across Stripe and non-Stripe environments |
| Finance suite | Ramp for Agents | Agent identity, budgets, cards, approvals, accounting | Avoid competing as a general corporate card or expense product |
| Issuing infrastructure | Lithic | Virtual cards, merchant locks, real-time authorization rules, webhooks | A strong future enforcement rail and design-partner ecosystem |
| Agent-native payments | AgentCard, Skyfire | Cards or wallets, agent checkout, identity, settlement | Treat as rails/integrations; Warden’s value must survive either one winning |
| Warden | Neutral mandate control plane | Operator intent, atomic authority, rail routing, evidence | Win on portability, policy compilation, provenance, and developer integration |

Sources:
[Ramp for Agents](https://agents.ramp.com/),
[Ramp agent identity](https://builders.ramp.com/post/agent-identity-introduction),
[Lithic agentic commerce](https://www.lithic.com/solutions/agentic-commerce),
[AgentCard documentation](https://docs.agentcard.sh/introduction),
[Skyfire product](https://skyfire.xyz/product/).

## The customer and wedge

The initial customer should not be a consumer who wants an agent to shop, nor a company
already satisfied with a single corporate-card platform.

The best initial customer hypothesis is:

> An agent platform or vertical SaaS company deploying purchasing agents for business
> customers, where the agent must act across multiple merchants or payment rails and the
> platform needs a defensible record of delegated authority.

Start with procurement and operational purchasing because the purpose, payee, budget, and
expiry are understandable, the demo is concrete, and responsibility matters. Good design
partners include:

- vertical procurement or inventory agents;
- browser/desktop agents that complete real checkouts;
- agent platforms adding paid tools, data, compute, or supplier purchases;
- finance teams experimenting outside their incumbent card stack.

## What the MVP proves

- An operator creates and activates immutable authority.
- The delegated agent discovers only its own mandates.
- The agent cannot self-declare identity or bypass mandates through the compatibility path.
- Budget and use reservations are atomic and idempotent.
- The same model can route to multiple card rails.
- Pending, settled, reversed, expired, multi-capture, and revocation races are accounted for.
- Evidence is append-only, hash-linked, recomputed on read, and visibly fails verification
  after tampering.
- The operator dashboard makes the lifecycle legible without exposing payment credentials.

This is enough for a strong technical demo. It is not proof that merchant scope is enforced
at the network, that local operator identity is trustworthy, or that card provisioning is
crash-safe.

## What must be built next

### 1. Production authorization, not post-settlement detection

Add at least one rail that can bind merchant/payee at authorization time, such as issuer
merchant locking or a real-time authorization callback. Until then, say:

> Warden enforces cumulative amount authority and verifies payee at settlement; network-level
> payee enforcement depends on rail capability.

### 2. AP2-compatible signed mandates

Map Warden mandates to AP2 intent/payment mandates, add organization-backed operator identity,
and sign canonical records with managed keys. A local SHA-256 chain is useful tamper evidence,
not independent attestation.

### 3. Crash-safe payment orchestration

Add upstream idempotency, provisioning leases, orphan-card discovery, webhook ingestion, and a
visible `revoking` state until rail closure is confirmed.

### 4. Multi-tenant organizational control

Add organizations, roles, agent sponsors, scoped credentials, approval policies, managed key
storage, and audit export. The current process-bound agent name and bearer-token operator are
MVP mechanisms only.

### 5. Integrations that create distribution

Ship an SDK/MCP package plus adapters for AP2, finance suites, issuing processors, and agent
frameworks. The moat is not a policy form; it is the integration graph and normalized history
of authority-to-outcome decisions.

## Ninety-day plan

### Days 0–30: prove the customer

- Interview 20 agent-platform, procurement, and finance-automation builders.
- Secure 3–5 design partners with a real purchase workflow and named technical owner.
- Measure how they authorize agents today, where payment credentials come from, and what
  evidence their customers require.
- Choose one production-capable enforcement rail.

### Days 31–60: prove real authorization

- Add organizational authentication and agent sponsorship.
- Add AP2 import/export plus signed mandate snapshots.
- Integrate webhook-first settlement and recoverable provisioning.
- Execute one payee-bound test transaction on the selected rail.

### Days 61–90: prove repeated value

- Run a design partner’s workflow repeatedly, not as a founder-operated demo.
- Track active agents, mandates created, authorization success/denial, recovery incidents,
  settled volume, and operator review time.
- Export evidence into the customer’s finance or audit workflow.

## Metrics worth showing a VC

Do not lead with seeded transaction volume or test counts as traction. Track:

- design partners running a real workflow weekly;
- active delegated agents and active operator sponsors;
- mandates created and percentage executed;
- authorization latency and successful recovery rate;
- out-of-scope attempts blocked before credential issuance;
- settled dollars with a complete authority-to-outcome record;
- number of rails and agent frameworks used by the same customer;
- time saved in approval, reconciliation, and audit review.

## Defensibility

Potential defensibility:

- a normalized mandate and evidence layer spanning competing protocols and rails;
- capability-aware policy compilation that knows what each rail can truly enforce;
- deeply embedded authorization integrations in agent platforms;
- a proprietary corpus of authority, execution, exception, and recovery outcomes;
- trust earned through operational reliability and audit integrations.

Not defensibility:

- a React dashboard;
- a local hash chain by itself;
- issuing one-time cards;
- generic policy rules;
- being an MCP server.

## Likely VC questions

**Isn’t this a feature for Stripe, Ramp, Visa, or Mastercard?**

It is if Warden is tied to one payment stack. The thesis is that agent builders will operate
across multiple rails, protocols, merchants, and customer finance systems. Warden is the
portable authority layer that compiles human intent into each system’s enforceable controls
and returns one evidence model. Design partners must validate that portability is painful
enough to buy.

**Why doesn’t AP2 eliminate Warden?**

AP2 is a protocol and vocabulary. Warden should be the operational runtime: operator UX,
identity, policy evaluation, rail capability negotiation, atomic reservation, lifecycle
recovery, and evidence delivery. If AP2 adoption removes those implementation problems, the
thesis weakens.

**Why not build a card program?**

Issuing is crowded, capital- and compliance-heavy, and increasingly bundled. Warden should
integrate with issuers and networks, remain non-custodial, and charge for control-plane
software.

**What is the business model?**

Validate a platform subscription plus usage per active agent, mandate, or authorization.
Avoid depending on interchange until customers and rails prove it is strategically necessary.

**What is the moat today?**

There is no durable moat yet. Today there is a coherent product thesis and credible technical
proof. The next moat milestone is repeat production usage across more than one rail by design
partners.

## The meeting ask

Ask the VC for:

1. introductions to five agent-platform or procurement-automation teams;
2. introductions to one issuer/network partner with merchant-bound authorization;
3. feedback on whether the neutral control-plane wedge is fundable before production pilots;
4. a follow-up after the first two design partners execute real transactions.

If fundraising now, frame it as a pre-seed to reach production authorization and design-partner
proof—not as capital to scale a proven payments business.
