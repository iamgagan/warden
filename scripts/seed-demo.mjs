// Demo seed: drives the real WardenService + Reconciler against MockUpstream
// and writes warden.db. Run `node scripts/seed-demo.mjs [db-path]` from the
// repo root after `pnpm build`, then start warden-api to browse the result.
import { openWardenDb } from '../packages/db/dist/index.js';
import { MockUpstream } from '../packages/mock-agentcard/dist/index.js';
import { Reconciler, WardenService } from '../packages/mcp/dist/index.js';
import { PolicyRulesSchema } from '../packages/core/dist/index.js';
import { rmSync } from 'node:fs';

const dbPath = process.argv[2] ?? './warden.db';
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

const db = openWardenDb(dbPath);
const upstream = new MockUpstream();
const reconciler = new Reconciler({ repo: db.repo, upstream, log: () => undefined });
const service = new WardenService({
  repo: db.repo,
  upstream,
  mode: 'test',
  reconcileNow: () => reconciler.runOnce(),
});

// A policy for the shopping agent: modest caps, one blocked merchant.
const shopper = db.repo.getOrCreateAgent('shopping-agent', 'personal shopping agent');
db.repo.setActivePolicy(
  shopper.id,
  JSON.stringify(
    PolicyRulesSchema.parse({
      per_card_cap_cents: 5000,
      per_task_budget_cents: 8000,
      blocked_merchants: ['sketchy-gift-cards.example'],
    }),
  ),
);

const purchases = [
  {
    agent: 'shopping-agent',
    intent: 'Restock office supplies: printer paper and pens, under $40 total',
    buys: [
      { merchant: 'Staples', amount: 1899 },
      { merchant: 'Staples', amount: 1249 },
    ],
  },
  {
    agent: 'shopping-agent',
    intent: 'Order Friday team lunch from the usual place, budget $50',
    buys: [{ merchant: 'DoorDash', amount: 4650 }],
  },
  {
    agent: 'research-agent',
    intent: 'Buy the PDF of the NIST agentic-payments whitepaper',
    buys: [{ merchant: 'NIST Bookstore', amount: 350 }],
  },
];

for (const scenario of purchases) {
  const task = service.startTask({
    agent_name: scenario.agent,
    intent: scenario.intent,
    budget_cents: 8000,
  });
  for (const buy of scenario.buys) {
    const card = await service.issueCard({
      task_id: task.task_id,
      amount_cents: buy.amount,
      merchant: buy.merchant,
    });
    upstream.simulatePurchase(card.card_id, { merchant: buy.merchant, amount_cents: buy.amount });
  }
  await reconciler.runOnce();
  await service.completeTask({ task_id: task.task_id });
}

// The demo-critical moments: a policy block at issuance and a network decline.
const attack = service.startTask({
  agent_name: 'shopping-agent',
  intent: 'Order Friday team lunch from the usual place, budget $50',
});
try {
  await service.issueCard({
    task_id: attack.task_id,
    amount_cents: 4900,
    merchant: 'sketchy-gift-cards.example',
  });
} catch (err) {
  console.log('policy block (issuance):', err.message);
}
const overCard = await service.issueCard({
  task_id: attack.task_id,
  amount_cents: 1500,
  merchant: 'DoorDash',
});
// merchant tries to charge more than the card holds → declines at the network
upstream.simulatePurchase(overCard.card_id, { merchant: 'DoorDash', amount_cents: 9900 });
await reconciler.runOnce();

const stats = db.repo.stats();
console.log('seeded', dbPath, JSON.stringify(stats));
db.close();
