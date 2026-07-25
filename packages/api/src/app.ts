import { Hono } from 'hono';
import { z } from 'zod';
import { PolicyRulesSchema } from '@warden/core';
import type { EvidenceListItem, EvidenceRow, MandateRow, PolicyRow, Repo } from '@warden/db';

export interface UpstreamAuthStatus {
  upstream_auth: 'ok' | 'needs_login';
}

export interface ApiOptions {
  repo: Repo;
  apiToken: string;
  mode: 'test' | 'live';
  /** Live reconciler status object (shared reference, read on demand). */
  reconcilerStatus?: UpstreamAuthStatus;
  /** Display attribution for approvals made through this local operator API. */
  operatorName?: string;
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

const policiesQuery = z.object({ agent: z.string().optional() });

const putPolicyBody = z.object({
  agent_name: z.string().min(1).nullable(),
  rules: PolicyRulesSchema,
});

const mandateBody = z
  .object({
    agent_name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(3).max(500),
    merchant: z.string().trim().min(1).max(160),
    amount_limit_cents: z.number().int().positive().max(100_000_000),
    per_transaction_limit_cents: z.number().int().positive().max(100_000_000).optional(),
    max_transactions: z.number().int().min(1).max(10_000).default(1),
    expires_at: z.string().datetime(),
    rail: z.enum(['auto', 'agentcard', 'stripe']).default('auto'),
    activate_now: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (new Date(value.expires_at).getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_at'],
        message: 'expiry must be in the future',
      });
    }
    if (
      value.per_transaction_limit_cents !== undefined &&
      value.per_transaction_limit_cents > value.amount_limit_cents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['per_transaction_limit_cents'],
        message: 'per-transaction limit cannot exceed the total budget',
      });
    }
  });

const revokeMandateBody = z.object({ reason: z.string().trim().min(1).max(300) });
const evidenceQuery = z.object({
  mandate: z.string().optional(),
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

  app.post('/api/v1/mandates', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = mandateBody.safeParse(body);
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    const input = parsed.data;
    const agent = repo.getOrCreateAgent(input.agent_name);
    let mandate = repo.createMandate({
      agentId: agent.id,
      purpose: input.purpose,
      merchant: input.merchant,
      amountLimitCents: input.amount_limit_cents,
      perTransactionLimitCents:
        input.per_transaction_limit_cents ?? input.amount_limit_cents,
      maxTransactions: input.max_transactions,
      expiresAt: input.expires_at,
      rail: input.rail,
      createdBy: opts.operatorName ?? 'Local operator',
    });
    if (input.activate_now) {
      mandate = repo.activateMandate(mandate.id, opts.operatorName ?? 'Local operator');
    }
    return c.json({ mandate: mandateJson(mandate, agent.name) }, 201);
  });

  app.get('/api/v1/mandates', (c) => {
    const status = c.req.query('status');
    const allowed = ['draft', 'active', 'exhausted', 'revoked', 'expired'] as const;
    if (status && !(allowed as readonly string[]).includes(status)) {
      return c.json(apiError('BAD_REQUEST', 'invalid mandate status'), 400);
    }
    const items = repo.listMandates(status as MandateRow['status'] | undefined);
    return c.json({
      mandates: items.map((mandate) =>
        mandateJson(mandate, repo.listAgents().find((agent) => agent.id === mandate.agentId)?.name ?? 'Unknown'),
      ),
    });
  });

  app.get('/api/v1/mandates/:id', (c) => {
    const mandate = repo.getMandate(c.req.param('id'));
    if (!mandate) return c.json(apiError('NOT_FOUND', 'no such mandate'), 404);
    const agent = repo.listAgents().find((item) => item.id === mandate.agentId);
    return c.json({ mandate: mandateJson(mandate, agent?.name ?? 'Unknown') });
  });

  app.post('/api/v1/mandates/:id/activate', (c) => {
    try {
      const mandate = repo.activateMandate(
        c.req.param('id'),
        opts.operatorName ?? 'Local operator',
      );
      const agent = repo.listAgents().find((item) => item.id === mandate.agentId);
      return c.json({ mandate: mandateJson(mandate, agent?.name ?? 'Unknown') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith('unknown mandate') ? 404 : 409;
      return c.json(apiError(status === 404 ? 'NOT_FOUND' : 'INVALID_STATE', message), status);
    }
  });

  app.post('/api/v1/mandates/:id/revoke', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = revokeMandateBody.safeParse(body);
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    try {
      const mandate = repo.revokeMandate(
        c.req.param('id'),
        parsed.data.reason,
        opts.operatorName ?? 'Local operator',
      );
      const agent = repo.listAgents().find((item) => item.id === mandate.agentId);
      return c.json({ mandate: mandateJson(mandate, agent?.name ?? 'Unknown') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith('unknown mandate') ? 404 : 409;
      return c.json(apiError(status === 404 ? 'NOT_FOUND' : 'INVALID_STATE', message), status);
    }
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
      receipts: items.map((receipt) =>
        receiptJson(receipt, repo.getEvidenceByReceipt(receipt.id)),
      ),
      next_cursor: items.length === limit ? items[items.length - 1]!.id : null,
    });
  });

  app.get('/api/v1/receipts/:id', (c) => {
    const receipt = repo.getReceipt(c.req.param('id'));
    if (!receipt) return c.json(apiError('NOT_FOUND', 'no such receipt'), 404);
    return c.json({
      ...receiptJson(receipt, repo.getEvidenceByReceipt(receipt.id)),
      decision: JSON.parse(receipt.decisionJson),
    });
  });

  app.get('/api/v1/evidence', (c) => {
    const parsed = evidenceQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    if (parsed.data.mandate && !repo.getMandate(parsed.data.mandate)) {
      return c.json(apiError('NOT_FOUND', 'no such mandate'), 404);
    }
    const items = repo.listEvidence({
      mandateId: parsed.data.mandate,
      limit: parsed.data.limit,
    });
    const verification = repo.verifyEvidenceChain();
    return c.json({
      evidence: items.map((row) => evidenceJson(row, verification.valid)),
      chain_verification: {
        verified: verification.valid,
        checked_records: verification.checkedRecords,
        first_invalid_sequence: verification.firstInvalidSequence,
      },
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

  app.get('/api/v1/policies', (c) => {
    const parsed = policiesQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    let agentId: string | null = null;
    if (parsed.data.agent) {
      const row = repo.getAgentByName(parsed.data.agent);
      if (!row) return c.json(apiError('NOT_FOUND', `unknown agent "${parsed.data.agent}"`), 404);
      agentId = row.id;
    }
    const active = repo.getActivePolicy(agentId);
    const versions = repo.listPolicyVersions(agentId);
    return c.json({
      agent_name: parsed.data.agent ?? null,
      active: active ? policyJson(active) : null,
      versions: versions.map(policyJson),
    });
  });

  app.put('/api/v1/policies', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = putPolicyBody.safeParse(body);
    if (!parsed.success) return c.json(apiError('BAD_REQUEST', parsed.error.message), 400);
    const { agent_name, rules } = parsed.data;
    const agentId = agent_name === null ? null : repo.getOrCreateAgent(agent_name).id;
    const row = repo.setActivePolicy(agentId, JSON.stringify(rules));
    return c.json({ agent_name, active: policyJson(row) });
  });

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
    const mandates = repo.listMandates();
    const activeMandates = mandates.filter((mandate) => mandate.status === 'active');
    return c.json({
      spend_under_management_cents: s.spendUnderManagementCents,
      receipts_total: s.receiptsTotal,
      blocks_total: s.blocksTotal,
      avg_blast_radius_cents: s.avgBlastRadiusCents,
      active_mandates: activeMandates.length,
      authority_available_cents: activeMandates.reduce(
        (sum, mandate) =>
          sum + mandate.amountLimitCents - mandate.reservedCents - mandate.settledCents,
        0,
      ),
      evidence_total: repo.listEvidence({ limit: 10_000 }).length,
    });
  });

  app.notFound((c) => c.json(apiError('NOT_FOUND', 'no such route'), 404));

  return app;
}

function mandateJson(row: MandateRow, agentName: string) {
  const available = Math.max(0, row.amountLimitCents - row.reservedCents - row.settledCents);
  return {
    id: row.id,
    status: row.status,
    agent_id: row.agentId,
    agent: agentName,
    task_id: row.taskId,
    purpose: row.purpose,
    merchant: row.merchant,
    currency: row.currency,
    amount_limit_cents: row.amountLimitCents,
    per_transaction_limit_cents: row.perTransactionLimitCents,
    max_transactions: row.maxTransactions,
    transaction_count: row.transactionCount,
    reserved_cents: row.reservedCents,
    settled_cents: row.settledCents,
    amount_available_cents: available,
    rail: row.rail,
    policy_id: row.policyId,
    policy_snapshot_hash: row.policySnapshotHash,
    mandate_hash: row.mandateHash,
    approved_by: row.approvedBy,
    created_at: row.createdAt,
    activated_at: row.activatedAt,
    expires_at: row.expiresAt,
    closed_at: row.closedAt,
    close_reason: row.closeReason,
    summary: `${agentName} may spend up to $${(row.amountLimitCents / 100).toFixed(2)} at ${row.merchant} for “${row.purpose}” before ${new Date(row.expiresAt).toLocaleDateString('en-US')}.`,
  };
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
  rail: string;
}, evidence?: EvidenceRow) {
  const decision = JSON.parse(r.decisionJson) as Record<string, unknown>;
  return {
    id: r.id,
    intent: r.intent,
    merchant: r.merchant,
    amount_cents: r.amountCents,
    currency: r.currency,
    category: r.category,
    card_id: r.cardId,
    rail: r.rail,
    task_id: r.taskId,
    policy_id: r.policyId,
    agent: r.agentName,
    transaction_status: r.transactionStatus,
    occurred_at: r.occurredAt,
    created_at: r.createdAt,
    decision_summary: summarizeDecision(decision),
    mandate_id: evidence?.mandateId ?? null,
    evidence_hash: evidence?.evidenceHash ?? null,
    evidence_outcome: evidence?.outcome ?? null,
  };
}

function evidenceJson(row: EvidenceListItem, chainVerified: boolean) {
  const payload = JSON.parse(row.payloadJson) as {
    decision?: string;
    checks?: unknown[];
    mandate?: Record<string, unknown>;
    authorization?: Record<string, unknown> | null;
    transaction?: Record<string, unknown>;
  };
  const mandate = payload.mandate ?? {};
  const transaction = payload.transaction ?? {};
  const hasSealedDisplayFacts =
    typeof mandate['purpose'] === 'string' &&
    typeof mandate['agent_name'] === 'string' &&
    typeof transaction['merchant'] === 'string' &&
    typeof transaction['amount_cents'] === 'number' &&
    typeof transaction['currency'] === 'string';
  return {
    id: row.id,
    receipt_id: row.receiptId,
    mandate_id: row.mandateId,
    authorization_id: row.authorizationId,
    transaction_id: row.transactionId,
    outcome: row.outcome,
    decision: payload.decision ?? 'unknown',
    checks: payload.checks ?? [],
    mandate,
    authorization: payload.authorization ?? null,
    transaction,
    merchant:
      typeof transaction['merchant'] === 'string' ? transaction['merchant'] : row.merchant,
    amount_cents:
      typeof transaction['amount_cents'] === 'number'
        ? transaction['amount_cents']
        : row.amountCents,
    currency:
      typeof transaction['currency'] === 'string' ? transaction['currency'] : row.currency,
    agent: typeof mandate['agent_name'] === 'string' ? mandate['agent_name'] : row.agentName,
    purpose: typeof mandate['purpose'] === 'string' ? mandate['purpose'] : row.purpose,
    integrity: {
      kind: 'sha256_chain_v1',
      sequence: row.sequence,
      evidence_hash: row.evidenceHash,
      previous_hash: row.previousHash,
      verified: chainVerified && hasSealedDisplayFacts,
    },
    created_at: row.createdAt,
  };
}

function policyJson(row: PolicyRow) {
  return {
    id: row.id,
    version: row.version,
    active: row.active === 1,
    rules: JSON.parse(row.rulesJson),
    created_at: row.createdAt,
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
