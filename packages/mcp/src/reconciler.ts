import type { CardRow, Repo } from '@warden/db';
import { UpstreamError, type Rail, type UpstreamClient, type UpstreamTxn } from '@warden/upstream';

export interface ReconcilerStatus {
  upstream_auth: 'ok' | 'needs_login';
  last_run_at: string | null;
  last_error: string | null;
}

export interface ReconcilerOptions {
  repo: Repo;
  /** One UpstreamClient per rail (SPEC §2.8); each card is reconciled against its own rail. */
  upstreams: Partial<Record<Rail, UpstreamClient>>;
  intervalMs?: number;
  log?: (line: string) => void;
}

/**
 * SPEC §3.4 (minus circuit breaker — T13, and TTL sweep — T14): polls upstream
 * transactions for every non-closed card, ingests them idempotently, and binds
 * each non-declined charge to its task's intent as an append-only receipt.
 * Failures are logged and retried next tick; they never crash the server.
 */
export class Reconciler {
  private readonly repo: Repo;
  private readonly upstreams: Partial<Record<Rail, UpstreamClient>>;
  private readonly intervalMs: number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  readonly status: ReconcilerStatus = {
    upstream_auth: 'ok',
    last_run_at: null,
    last_error: null,
  };

  constructor(opts: ReconcilerOptions) {
    this.repo = opts.repo;
    this.upstreams = opts.upstreams;
    this.intervalMs = opts.intervalMs ?? Number(process.env['RECONCILE_INTERVAL_MS'] ?? 30_000);
    this.log = opts.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One full pass. Safe to call concurrently (overlapping calls no-op). */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let passError: string | null = null;
      const cards = [...this.repo.listCardsByState('open'), ...this.repo.listCardsByState('used')];
      for (const card of cards) {
        try {
          await this.reconcileCard(card);
        } catch (err) {
          if (err instanceof UpstreamError && err.code === 'UPSTREAM_AUTH_REQUIRED') {
            this.status.upstream_auth = 'needs_login';
            this.status.last_error = err.message;
            this.log(`[reconciler] upstream auth required: ${err.message}; run \`warden auth\``);
            return; // no point continuing the pass without auth
          }
          passError = err instanceof Error ? err.message : String(err);
          this.log(`[reconciler] card ${card.id}: ${passError}`);
        }
      }
      this.status.upstream_auth = 'ok';
      this.status.last_error = passError;
    } finally {
      this.status.last_run_at = new Date().toISOString();
      this.running = false;
    }
  }

  private async reconcileCard(card: CardRow): Promise<void> {
    const upstream = this.upstreams[card.rail];
    if (!upstream) {
      this.log(`[reconciler] card ${card.id}: rail '${card.rail}' is not configured, skipping`);
      return;
    }
    const txns = await upstream.listTransactions(card.id);
    for (const txn of txns) {
      this.ingestTransaction(card, txn);
    }
    // Stripe Issuing cards don't auto-cancel after one authorized payment the
    // way AgentCard's do (SPEC §2.8) — Warden closes them here to reproduce
    // single-use semantics operationally once the first non-declined
    // authorization lands. A decline alone doesn't consume the single use,
    // matching AgentCard's "auto-cancel after one authorized payment".
    const hasAuthorizedTxn = txns.some((t) => t.status !== 'DECLINED');
    const stateNow = this.repo.getCard(card.id)?.state;
    if (card.rail === 'stripe' && hasAuthorizedTxn && stateNow && stateNow !== 'closed') {
      try {
        await upstream.closeCard(card.id);
        if (this.repo.getCard(card.id)?.state !== 'closed') {
          this.repo.setCardState(card.id, 'closed');
        }
      } catch (err) {
        this.log(`[reconciler] card ${card.id}: stripe single-use close failed: ${String(err)}`);
      }
    }
  }

  private ingestTransaction(card: CardRow, txn: UpstreamTxn): void {
    const task = this.repo.getTask(card.taskId);
    if (!task) return;

    const existing = this.repo.getTransaction(txn.id);
    if (!existing) {
      this.repo.insertTransactionIfNew({
        id: txn.id,
        cardId: card.id,
        merchant: txn.merchant,
        amountCents: txn.amount_cents,
        currency: txn.currency,
        category: txn.category,
        status: txn.status,
        rawJson: JSON.stringify(txn.raw ?? {}),
        occurredAt: txn.occurred_at,
      });

      if (txn.status === 'DECLINED') {
        // The demo-critical "the card said no" moment: no receipt, a network
        // -enforced block event instead.
        this.repo.insertPolicyEvent({
          type: 'block',
          taskId: task.id,
          agentId: task.agentId,
          detailsJson: JSON.stringify({
            enforced_at: 'network',
            card_id: card.id,
            transaction_id: txn.id,
            merchant: txn.merchant,
            amount_cents: txn.amount_cents,
          }),
        });
      } else {
        this.repo.insertReceipt({
          transactionId: txn.id,
          taskId: task.id,
          intent: task.intent,
          policyId: task.policyId,
          decisionJson: JSON.stringify({
            decision: 'issue',
            card_id: card.id,
            card_amount_cents: card.amountCents,
            policy_id: task.policyId,
            merchant_hint: card.merchantHint,
            sandbox: card.sandbox === 1,
          }),
        });
      }
    } else if (existing.status !== txn.status) {
      this.repo.updateTransactionStatus(txn.id, txn.status);
    }

    // Settlement: single-use card is spent. True the reservation up to the
    // settled amount and mark the card used, exactly once (open → used).
    if (txn.status === 'SETTLED' && this.repo.getCard(card.id)?.state === 'open') {
      this.repo.setCardState(card.id, 'used');
      this.repo.addTaskSpent(task.id, txn.amount_cents - card.amountCents);
    }
  }
}
