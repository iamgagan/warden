import { Hono } from 'hono';
import { z } from 'zod';
import type { Repo } from '@warden/db';

export interface UpstreamAuthStatus {
  upstream_auth: 'ok' | 'needs_login';
}

export interface ApiOptions {
  repo: Repo;
  apiToken: string;
  mode: 'test' | 'live';
  /** Live reconciler status object (shared reference, read on demand). */
  reconcilerStatus?: UpstreamAuthStatus;
}

const apiError = (code: string, message: string) => ({ error: { code, message } });

const listQuery = z.object({
  agent: z.string().optional(),
  task: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

const eventsQuery = z.object({
  type: z
    .enum(['block', 'circuit_break', 'approval_required', 'approved', 'denied', 'card_issued', 'card_closed'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** SPEC §3.3 — read paths (T9). Bearer auth on everything except /healthz. */
export function createApiApp(opts: ApiOptions): Hono {
  const { repo } = opts;
  const app = new Hono();

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      mode: opts.mode,
      upstream_auth: opts.reconcilerStatus?.upstream_auth ?? 'ok',
    }),
  );

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    if (header !== `Bearer ${opts.apiToken}`) {
      return c.json(apiError('UNAUTHORIZED', 'missing or invalid bearer token'), 401);
    }
    await next();
  });

  app.get('/api/v1/receipts', (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    const { agent, task, limit, cursor } = parsed.data;
    let agentId: string | undefined;
    if (agent) {
      const row = repo.getAgentByName(agent);
      if (!row) return c.json(apiError('NOT_FOUND', `unknown agent "${agent}"`), 404);
      agentId = row.id;
    }
    const items = repo.listReceipts({ agentId, taskId: task, limit, cursor });
    return c.json({
      receipts: items.map(receiptJson),
      next_cursor: items.length === limit ? items[items.length - 1]!.id : null,
    });
  });

  app.get('/api/v1/receipts/:id', (c) => {
    const receipt = repo.getReceipt(c.req.param('id'));
    if (!receipt) return c.json(apiError('NOT_FOUND', 'no such receipt'), 404);
    return c.json({
      ...receiptJson(receipt),
      decision: JSON.parse(receipt.decisionJson),
    });
  });

  app.get('/api/v1/agents', (c) =>
    c.json({
      agents: repo.agentRollups().map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        created_at: a.createdAt,
        total_spent_cents: a.totalSpentCents,
        receipts: a.receipts,
        blocks: a.blocks,
      })),
    }),
  );

  app.get('/api/v1/events', (c) => {
    const parsed = eventsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    const events = repo.listPolicyEvents(parsed.data);
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        task_id: e.taskId,
        agent_id: e.agentId,
        details: JSON.parse(e.detailsJson),
        created_at: e.createdAt,
      })),
    });
  });

  app.get('/api/v1/stats', (c) => {
    const s = repo.stats();
    return c.json({
      spend_under_management_cents: s.spendUnderManagementCents,
      receipts_total: s.receiptsTotal,
      blocks_total: s.blocksTotal,
      avg_blast_radius_cents: s.avgBlastRadiusCents,
    });
  });

  app.notFound((c) => c.json(apiError('NOT_FOUND', 'no such route'), 404));

  return app;
}

function receiptJson(r: {
  id: string;
  intent: string;
  merchant: string;
  amountCents: number;
  currency: string;
  category: string | null;
  cardId: string;
  occurredAt: string;
  createdAt: string;
  taskId: string;
  policyId: string | null;
  agentName: string;
  transactionStatus: string;
  decisionJson: string;
}) {
  const decision = JSON.parse(r.decisionJson) as Record<string, unknown>;
  return {
    id: r.id,
    intent: r.intent,
    merchant: r.merchant,
    amount_cents: r.amountCents,
    currency: r.currency,
    category: r.category,
    card_id: r.cardId,
    task_id: r.taskId,
    policy_id: r.policyId,
    agent: r.agentName,
    transaction_status: r.transactionStatus,
    occurred_at: r.occurredAt,
    created_at: r.createdAt,
    decision_summary: summarizeDecision(decision),
  };
}

function summarizeDecision(decision: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof decision['decision'] === 'string') parts.push(String(decision['decision']));
  if (typeof decision['card_amount_cents'] === 'number') {
    parts.push(`card capped at $${((decision['card_amount_cents'] as number) / 100).toFixed(2)}`);
  }
  if (decision['sandbox'] === true) parts.push('sandbox');
  return parts.join(' · ') || 'issue';
}
