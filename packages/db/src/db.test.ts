import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { openWardenDb, type WardenDb } from './client.js';
import type { TransactionRow } from './schema.js';

let db: WardenDb;
const futureExpiry = (): string =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  db = openWardenDb(':memory:');
});

afterEach(() => {
  db.close();
});

function seedTaskWithCard() {
  const agent = db.repo.getOrCreateAgent('shopper');
  const task = db.repo.createTask({
    agentId: agent.id,
    intent: 'restock office supplies',
    budgetCents: 4000,
    policyId: null,
  });
  const card = db.repo.insertCard({
    id: 'card_1',
    taskId: task.id,
    amountCents: 1500,
    merchantHint: 'staples',
    sandbox: true,
    rail: 'agentcard',
  });
  return { agent, task, card };
}

function txnRow(id: string, cardId: string, overrides?: Partial<TransactionRow>): Omit<TransactionRow, 'ingestedAt'> {
  return {
    id,
    cardId,
    merchant: 'staples',
    amountCents: 1499,
    currency: 'USD',
    category: null,
    status: 'SETTLED',
    rawJson: '{}',
    occurredAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('migrations', () => {
  it('are idempotent', () => {
    migrate(db.sqlite); // second run over an already-migrated database
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of [
      'agents',
      'policies',
      'tasks',
      'mandates',
      'authorizations',
      'cards',
      'transactions',
      'receipts',
      'evidence',
      'policy_events',
      'approvals',
    ]) {
      expect(names).toContain(t);
    }
  });
});

describe('agents', () => {
  it('getOrCreateAgent is idempotent and names are unique', () => {
    const a = db.repo.getOrCreateAgent('shopper', 'buys things');
    const b = db.repo.getOrCreateAgent('shopper');
    expect(b.id).toBe(a.id);
    expect(db.repo.listAgents()).toHaveLength(1);
    expect(() =>
      db.sqlite
        .prepare("INSERT INTO agents (id, name, created_at) VALUES ('x', 'shopper', 'now')")
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe('policies', () => {
  it('keeps exactly one active policy per agent scope, with version bumps', () => {
    const agent = db.repo.getOrCreateAgent('shopper');
    const v1 = db.repo.setActivePolicy(agent.id, '{"a":1}');
    const v2 = db.repo.setActivePolicy(agent.id, '{"a":2}');
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    const versions = db.repo.listPolicyVersions(agent.id);
    expect(versions).toHaveLength(2);
    expect(versions.filter((p) => p.active === 1)).toHaveLength(1);
    expect(db.repo.getActivePolicy(agent.id)?.id).toBe(v2.id);
  });

  it('global default is scoped independently and used as fallback', () => {
    const agent = db.repo.getOrCreateAgent('shopper');
    const global1 = db.repo.setActivePolicy(null, '{"global":1}');
    expect(db.repo.getActivePolicy(agent.id)?.id).toBe(global1.id); // fallback
    const specific = db.repo.setActivePolicy(agent.id, '{"specific":1}');
    expect(db.repo.getActivePolicy(agent.id)?.id).toBe(specific.id);
    expect(db.repo.getActivePolicy(null)?.id).toBe(global1.id);
    // global versioning is independent of agent versioning
    expect(specific.version).toBe(1);
  });
});

describe('tasks and cards', () => {
  it('tracks spend and status transitions', () => {
    const { task } = seedTaskWithCard();
    db.repo.addTaskSpent(task.id, 1000);
    db.repo.addTaskSpent(task.id, 250);
    expect(db.repo.getTask(task.id)?.spentCents).toBe(1250);
    db.repo.setTaskStatus(task.id, 'completed');
    const closed = db.repo.getTask(task.id);
    expect(closed?.status).toBe('completed');
    expect(closed?.closedAt).not.toBeNull();
  });

  it('finds open cards older than a TTL cutoff', () => {
    const { card } = seedTaskWithCard();
    expect(db.repo.listOpenCardsCreatedBefore('2999-01-01T00:00:00.000Z').map((c) => c.id)).toEqual([
      card.id,
    ]);
    expect(db.repo.listOpenCardsCreatedBefore('2000-01-01T00:00:00.000Z')).toHaveLength(0);
    db.repo.setCardState(card.id, 'used');
    expect(db.repo.listOpenCardsCreatedBefore('2999-01-01T00:00:00.000Z')).toHaveLength(0);
  });
});

describe('mandates and atomic authorizations', () => {
  it('activates immutable operator authority and creates its task projection', () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const mandate = db.repo.createMandate({
      agentId: agent.id,
      purpose: 'Buy printer paper for the New York office',
      merchant: 'Staples',
      amountLimitCents: 4000,
      perTransactionLimitCents: 2500,
      maxTransactions: 3,
      expiresAt: futureExpiry(),
      rail: 'agentcard',
      createdBy: 'local-operator',
    });

    expect(mandate.status).toBe('draft');
    const active = db.repo.activateMandate(mandate.id, 'local-operator');
    expect(active).toMatchObject({
      status: 'active',
      approvedBy: 'local-operator',
      amountLimitCents: 4000,
      reservedCents: 0,
      settledCents: 0,
      transactionCount: 0,
    });
    expect(active.taskId).not.toBeNull();
    expect(db.repo.getTask(active.taskId!)?.mandateId).toBe(mandate.id);
    expect(active.mandateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reserves cumulative budget atomically and makes retries idempotent', () => {
    const agent = db.repo.getOrCreateAgent('procurement-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy supplies',
        merchant: 'Staples',
        amountLimitCents: 1000,
        perTransactionLimitCents: 1000,
        maxTransactions: 2,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );

    const first = db.repo.reserveAuthorization({
      mandateId: mandate.id,
      taskId: mandate.taskId!,
      idempotencyKey: 'checkout-1',
      requestHash: 'request-a',
      amountCents: 800,
      merchant: 'Staples',
      category: null,
      rail: 'agentcard',
    });
    const retry = db.repo.reserveAuthorization({
      mandateId: mandate.id,
      taskId: mandate.taskId!,
      idempotencyKey: 'checkout-1',
      requestHash: 'request-a',
      amountCents: 800,
      merchant: 'Staples',
      category: null,
      rail: 'agentcard',
    });
    const overspend = db.repo.reserveAuthorization({
      mandateId: mandate.id,
      taskId: mandate.taskId!,
      idempotencyKey: 'checkout-2',
      requestHash: 'request-b',
      amountCents: 800,
      merchant: 'Staples',
      category: null,
      rail: 'agentcard',
    });

    expect(first.kind).toBe('reserved');
    expect(retry).toMatchObject({ kind: 'existing' });
    expect(retry.authorization.id).toBe(first.authorization.id);
    expect(overspend).toMatchObject({ kind: 'denied', reason: 'budget_unavailable' });
    expect(db.repo.getMandate(mandate.id)).toMatchObject({
      reservedCents: 800,
      transactionCount: 1,
    });
    expect(db.repo.getTask(mandate.taskId!)?.spentCents).toBe(800);
  });

  it('preserves Unicode merchant identity instead of normalizing distinct names to empty', () => {
    const agent = db.repo.getOrCreateAgent('international-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy supplies in Tokyo',
        merchant: '東京商店',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    const result = db.repo.reserveAuthorization({
      mandateId: mandate.id,
      taskId: mandate.taskId!,
      idempotencyKey: 'unicode-merchant',
      requestHash: 'unicode-request',
      amountCents: 500,
      merchant: '恶意商店',
      category: null,
      rail: 'agentcard',
    });
    expect(result).toMatchObject({ kind: 'denied', reason: 'merchant_not_allowed' });
  });

  it('expires the linked task when mandate listing discovers elapsed authority', () => {
    const agent = db.repo.getOrCreateAgent('expiry-agent');
    const mandate = db.repo.activateMandate(
      db.repo.createMandate({
        agentId: agent.id,
        purpose: 'Buy supplies',
        merchant: 'Staples',
        amountLimitCents: 2000,
        perTransactionLimitCents: 2000,
        maxTransactions: 1,
        expiresAt: futureExpiry(),
        rail: 'agentcard',
        createdBy: 'local-operator',
      }).id,
      'local-operator',
    );
    db.sqlite
      .prepare("UPDATE mandates SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(mandate.id);

    expect(db.repo.listMandates().find((row) => row.id === mandate.id)?.status).toBe('expired');
    expect(db.repo.getTask(mandate.taskId!)?.status).toBe('expired');
  });
});

describe('transactions', () => {
  it('insertTransactionIfNew is idempotent on the upstream id', () => {
    const { card } = seedTaskWithCard();
    expect(db.repo.insertTransactionIfNew(txnRow('txn_1', card.id))).toBe(true);
    expect(db.repo.insertTransactionIfNew(txnRow('txn_1', card.id))).toBe(false);
    expect(db.repo.listTransactionsByCard(card.id)).toHaveLength(1);
  });
});

describe('receipts', () => {
  it('binds intent + decision and joins transaction/agent detail', () => {
    const { agent, task, card } = seedTaskWithCard();
    db.repo.insertTransactionIfNew(txnRow('txn_1', card.id));
    const receipt = db.repo.insertReceipt({
      transactionId: 'txn_1',
      taskId: task.id,
      intent: task.intent,
      policyId: null,
      decisionJson: '{"kind":"issue"}',
    });
    const listed = db.repo.listReceipts({ limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: receipt.id,
      intent: 'restock office supplies',
      merchant: 'staples',
      amountCents: 1499,
      cardId: card.id,
      agentId: agent.id,
      agentName: 'shopper',
    });
    expect(db.repo.getReceipt(receipt.id)?.id).toBe(receipt.id);
  });

  it('is unique per transaction (append-only, corrections are new rows elsewhere)', () => {
    const { task, card } = seedTaskWithCard();
    db.repo.insertTransactionIfNew(txnRow('txn_1', card.id));
    db.repo.insertReceipt({
      transactionId: 'txn_1',
      taskId: task.id,
      intent: 'x',
      policyId: null,
      decisionJson: '{}',
    });
    expect(() =>
      db.repo.insertReceipt({
        transactionId: 'txn_1',
        taskId: task.id,
        intent: 'x',
        policyId: null,
        decisionJson: '{}',
      }),
    ).toThrow(/UNIQUE/);
  });

  it('exports no update or delete for receipts (append-only surface)', () => {
    const repoKeys = Object.keys(db.repo).filter((k) => k.toLowerCase().includes('receipt'));
    expect(repoKeys.sort()).toEqual([
      'countReceipts',
      'getEvidenceByReceipt',
      'getReceipt',
      'getReceiptByTransaction',
      'insertReceipt',
      'listReceipts',
    ]);
  });

  it('paginates with a cursor, newest first', () => {
    const { task, card } = seedTaskWithCard();
    for (let i = 0; i < 5; i++) {
      db.repo.insertTransactionIfNew(txnRow(`txn_${i}`, card.id));
      db.repo.insertReceipt({
        transactionId: `txn_${i}`,
        taskId: task.id,
        intent: 'x',
        policyId: null,
        decisionJson: '{}',
      });
    }
    const page1 = db.repo.listReceipts({ limit: 2 });
    expect(page1).toHaveLength(2);
    const page2 = db.repo.listReceipts({ limit: 2, cursor: page1[1]!.id });
    expect(page2).toHaveLength(2);
    const page3 = db.repo.listReceipts({ limit: 2, cursor: page2[1]!.id });
    expect(page3).toHaveLength(1);
    const allIds = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(new Set(allIds).size).toBe(5);
  });
});

describe('approvals', () => {
  it('decides only pending approvals', () => {
    const { task } = seedTaskWithCard();
    const approval = db.repo.createApproval({
      taskId: task.id,
      merchant: 'apple',
      amountCents: 9000,
      reason: 'over threshold',
    });
    db.repo.decideApproval(approval.id, 'approved', 'gagan');
    db.repo.decideApproval(approval.id, 'denied', 'someone-else'); // no-op: already decided
    const decided = db.repo.getApproval(approval.id);
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe('gagan');
  });
});

describe('rollups', () => {
  it('aggregates spend, receipts, and blocks per agent', () => {
    const { agent, task, card } = seedTaskWithCard();
    db.repo.addTaskSpent(task.id, 1499);
    db.repo.insertTransactionIfNew(txnRow('txn_1', card.id));
    db.repo.insertReceipt({
      transactionId: 'txn_1',
      taskId: task.id,
      intent: 'x',
      policyId: null,
      decisionJson: '{}',
    });
    db.repo.insertPolicyEvent({
      type: 'block',
      taskId: task.id,
      agentId: agent.id,
      detailsJson: '{}',
    });
    const rollups = db.repo.agentRollups();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      name: 'shopper',
      totalSpentCents: 1499,
      receipts: 1,
      blocks: 1,
    });
  });
});
