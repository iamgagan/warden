import type { CardRow, ReceiptRow, Repo, TaskRow } from '@warden/db';
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
    const task = this.repo.getTask(card.taskId);
    let inactiveMandateReason: string | null = null;
    if (task?.mandateId) {
      const mandate = this.repo.getMandate(task.mandateId);
      if (!mandate || mandate.status !== 'active') {
        inactiveMandateReason = `mandate_${mandate?.status ?? 'missing'}`;
        // Stop new authorizations first, then make one final rail read. A
        // settlement may have landed immediately before revocation/expiry and
        // must never disappear from accounting just because authority closed.
        await upstream.closeCard(card.id);
      }
    }
    const txns = await upstream.listTransactions(card.id);
    for (const txn of txns) {
      this.ingestTransaction(card, txn);
    }
    if (inactiveMandateReason && task?.mandateId) {
      const hasPendingAuthorization = txns.some((txn) => txn.status === 'PENDING');
      if (hasPendingAuthorization) {
        // Canceling a card prevents new authorizations but does not erase an
        // already-approved capture. Keep it in the polled `used` set until
        // the rail reports a terminal outcome.
        this.repo.setCardState(card.id, 'used');
      } else {
        const authorization = this.repo.getAuthorizationByCard(card.id);
        if (authorization) this.repo.releaseAuthorization(authorization.id);
        this.repo.setCardState(card.id, 'closed');
      }
      if (card.state === 'open') {
        this.repo.insertPolicyEvent({
          type: 'card_closed',
          taskId: task.id,
          agentId: task.agentId,
          detailsJson: JSON.stringify({
            card_id: card.id,
            mandate_id: task.mandateId,
            reason: inactiveMandateReason,
            settlement_pending: hasPendingAuthorization,
          }),
        });
      }
      return;
    }
    // Stripe Issuing cards don't auto-cancel after one authorized payment the
    // way AgentCard's do (SPEC §2.8) — Warden closes them here to reproduce
    // single-use semantics operationally once the first non-declined
    // authorization lands. A decline alone doesn't consume the single use,
    // matching AgentCard's "auto-cancel after one authorized payment".
    const hasAuthorizedTxn = txns.some((t) => t.status !== 'DECLINED');
    const hasPendingAuthorization = txns.some((t) => t.status === 'PENDING');
    const hasSettlement = txns.some((t) => t.status === 'SETTLED');
    const stateNow = this.repo.getCard(card.id)?.state;
    if (card.rail === 'stripe' && hasAuthorizedTxn && stateNow && stateNow !== 'closed') {
      try {
        await upstream.closeCard(card.id);
        // A Stripe authorization and its later capture use different IDs.
        // `used` means "credential closed, terminal settlement still polled".
        this.repo.setCardState(
          card.id,
          hasPendingAuthorization && !hasSettlement ? 'used' : 'closed',
        );
      } catch (err) {
        this.log(`[reconciler] card ${card.id}: stripe single-use close failed: ${String(err)}`);
      }
    }
  }

  private ingestTransaction(card: CardRow, txn: UpstreamTxn): void {
    const task = this.repo.getTask(card.taskId);
    if (!task) return;

    const existing = this.repo.getTransaction(txn.id);
    const stateChanged = !existing || existing.status !== txn.status;
    let receipt = this.repo.getReceiptByTransaction(txn.id);
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
        receipt = this.repo.insertReceipt({
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

    if (txn.status !== 'DECLINED' && task.mandateId && receipt && stateChanged) {
      this.recordMandateEvidence(card, task, txn, receipt);
    }

    // Settlement: single-use card is spent. True the reservation up to the
    // settled amount and mark the card used, exactly once (open → used).
    if (txn.status === 'SETTLED') {
      const authorization = this.repo.getAuthorizationByCard(card.id);
      if (authorization) {
        const cumulativeSettled = this.repo
          .listTransactionsByCard(card.id)
          .filter((transaction) => transaction.status === 'SETTLED')
          .reduce((sum, transaction) => sum + transaction.amountCents, 0);
        if (this.repo.settleAuthorization(authorization.id, cumulativeSettled)) {
          this.repo.setCardState(card.id, 'used');
        }
      } else if (this.repo.getCard(card.id)?.state === 'open') {
        this.repo.setCardState(card.id, 'used');
        this.repo.addTaskSpent(task.id, txn.amount_cents - card.amountCents);
      }
    }
    if (['REVERSED', 'EXPIRED'].includes(txn.status)) {
      const authorization = this.repo.getAuthorizationByCard(card.id);
      if (authorization) this.repo.releaseAuthorization(authorization.id);
    }
  }

  private recordMandateEvidence(
    card: CardRow,
    task: TaskRow,
    txn: UpstreamTxn,
    receipt: ReceiptRow,
  ): void {
    if (!task.mandateId) return;
    const mandate = this.repo.getMandate(task.mandateId);
    const authorization = this.repo.getAuthorizationByCard(card.id);
    const agent = this.repo.getAgent(task.agentId);
    if (!mandate) return;
    const merchantMatched =
      normalizeMerchant(mandate.merchant) === normalizeMerchant(txn.merchant);
    const cumulativeSettled = this.repo
      .listTransactionsByCard(card.id)
      .filter((transaction) => transaction.status === 'SETTLED')
      .reduce((sum, transaction) => sum + transaction.amountCents, 0);
    const amountMatched =
      authorization !== undefined &&
      txn.amount_cents <= authorization.amountCents &&
      cumulativeSettled <= authorization.amountCents;
    const railMatched = authorization !== undefined && authorization.rail === card.rail;
    const matched = merchantMatched && amountMatched && railMatched;
    const checks = [
      {
        code: 'PAYEE_MATCH',
        result: merchantMatched ? 'pass' : 'fail',
        explanation: merchantMatched
          ? `Observed merchant matches ${mandate.merchant}.`
          : `Observed ${txn.merchant}; mandate named ${mandate.merchant}.`,
      },
      {
        code: 'AMOUNT_WITHIN_AUTHORIZATION',
        result: amountMatched ? 'pass' : 'fail',
        explanation: amountMatched
          ? 'Observed amount is within the reserved authorization.'
          : 'Observed amount exceeds or lacks a reserved authorization.',
      },
      {
        code: 'RAIL_BOUND',
        result: railMatched ? 'pass' : 'fail',
        explanation: railMatched
          ? `Observed on the approved ${card.rail} rail.`
          : 'Observed rail does not match the authorization.',
      },
    ];
    this.repo.insertEvidence({
      receiptId: receipt.id,
      mandateId: mandate.id,
      authorizationId: authorization?.id ?? null,
      transactionId: txn.id,
      eventKey: `${txn.id}:${txn.status}`,
      outcome: matched ? transactionOutcome(txn.status) : 'violation',
      payload: {
        decision: matched ? 'matched' : 'mismatch',
        checks,
        mandate: {
          id: mandate.id,
          hash: mandate.mandateHash,
          approved_by: mandate.approvedBy,
          agent_id: mandate.agentId,
          agent_name: agent?.name ?? 'Unknown agent',
          purpose: mandate.purpose,
          merchant: mandate.merchant,
          amount_limit_cents: mandate.amountLimitCents,
          expires_at: mandate.expiresAt,
          policy_id: mandate.policyId,
          policy_snapshot_hash: mandate.policySnapshotHash,
        },
        authorization: authorization
          ? {
              id: authorization.id,
              amount_cents: authorization.amountCents,
              merchant: authorization.merchant,
              rail: authorization.rail,
            }
          : null,
        transaction: {
          id: txn.id,
          merchant: txn.merchant,
          amount_cents: txn.amount_cents,
          currency: txn.currency,
          category: txn.category,
          status: txn.status,
          rail: card.rail,
          occurred_at: txn.occurred_at,
        },
      },
    });
    if (!matched) {
      this.repo.insertPolicyEvent({
        type: 'block',
        taskId: task.id,
        agentId: task.agentId,
        detailsJson: JSON.stringify({
          enforced_at: 'evidence',
          mandate_id: mandate.id,
          transaction_id: txn.id,
          reasons: checks
            .filter((check) => check.result === 'fail')
            .map((check) => check.explanation),
        }),
      });
    }
  }
}

function normalizeMerchant(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function transactionOutcome(
  status: UpstreamTxn['status'],
): 'pending' | 'settled' | 'declined' | 'reversed' | 'refunded' {
  switch (status) {
    case 'SETTLED':
      return 'settled';
    case 'DECLINED':
      return 'declined';
    case 'REVERSED':
    case 'EXPIRED':
      return 'reversed';
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'pending';
  }
}
