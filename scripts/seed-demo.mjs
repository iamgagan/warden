// Seeds a polished mandate-first demo against the real service, repository,
// reconciler, and mock payment rail. Run after `pnpm build`.
import { rmSync } from 'node:fs';
import { PolicyRulesSchema } from '../packages/core/dist/index.js';
import { openWardenDb } from '../packages/db/dist/index.js';
import { MockUpstream } from '../packages/mock-agentcard/dist/index.js';
import { Reconciler, WardenService } from '../packages/mcp/dist/index.js';

const dbPath = process.argv[2] ?? './warden-demo.db';
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

const db = openWardenDb(dbPath);
const upstream = new MockUpstream();
const upstreams = { agentcard: upstream };
const reconciler = new Reconciler({ repo: db.repo, upstreams, log: () => undefined });
const service = new WardenService({
  repo: db.repo,
  upstreams,
  mode: 'test',
  reconcileNow: () => reconciler.runOnce(),
  actorAgentName: 'procurement-agent',
});

const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const agent = db.repo.getOrCreateAgent(
  'procurement-agent',
  'Purchases bounded operational supplies',
);
db.repo.setActivePolicy(
  agent.id,
  JSON.stringify(
    PolicyRulesSchema.parse({
      per_card_cap_cents: 5000,
      per_task_budget_cents: 15_000,
      blocked_merchants: ['sketchy-gift-cards.example'],
      velocity: { max_cards_per_hour: 8, max_amount_cents_per_day: 20_000 },
    }),
  ),
);

const createActive = (input) =>
  db.repo.activateMandate(
    db.repo.createMandate({
      agentId: agent.id,
      rail: 'agentcard',
      createdBy: 'Gagan Singh',
      expiresAt,
      ...input,
    }).id,
    'Gagan Singh',
  );

const staples = createActive({
  purpose: 'Restock printer paper for the New York office',
  merchant: 'Staples',
  amountLimitCents: 4000,
  perTransactionLimitCents: 2500,
  maxTransactions: 3,
});
const staplesCard = await service.issueCard({
  task_id: staples.taskId,
  amount_cents: 1899,
  merchant: 'Staples',
  idempotency_key: 'staples-paper-order',
});
upstream.simulatePurchase(staplesCard.card_id, {
  merchant: 'STAPLES',
  amount_cents: 1899,
});
await reconciler.runOnce();

const nist = createActive({
  purpose: 'Purchase the NIST agentic payments research brief',
  merchant: 'NIST Bookstore',
  amountLimitCents: 1200,
  perTransactionLimitCents: 1200,
  maxTransactions: 1,
});
const nistCard = await service.issueCard({
  task_id: nist.taskId,
  amount_cents: 350,
  merchant: 'NIST Bookstore',
  idempotency_key: 'nist-brief',
});
upstream.simulatePurchase(nistCard.card_id, {
  merchant: 'NIST BOOKSTORE',
  amount_cents: 350,
});
await reconciler.runOnce();

const lunch = createActive({
  purpose: 'Order Friday team lunch for the product group',
  merchant: 'DoorDash',
  amountLimitCents: 5000,
  perTransactionLimitCents: 5000,
  maxTransactions: 1,
});

try {
  await service.issueCard({
    task_id: lunch.taskId,
    amount_cents: 1999,
    merchant: 'sketchy-gift-cards.example',
    idempotency_key: 'prompt-injection-attempt',
  });
} catch {
  // Expected: the mandate and policy both fail closed.
}

db.repo.createMandate({
  agentId: agent.id,
  purpose: 'Renew the shared design asset subscription',
  merchant: 'Figma',
  amountLimitCents: 1500,
  perTransactionLimitCents: 1500,
  maxTransactions: 1,
  expiresAt,
  rail: 'auto',
  createdBy: 'Gagan Singh',
});

console.log(
  JSON.stringify({
    db: dbPath,
    mandates: db.repo.listMandates().length,
    evidence: db.repo.listEvidence({ limit: 100 }).length,
    stats: db.repo.stats(),
  }),
);
db.close();
