import {
  UpstreamError,
  type CardCredentials,
  type CardSummary,
  type UpstreamClient,
  type UpstreamTxn,
  type UpstreamTxnStatus,
} from '@warden/upstream';

const MIN_CENTS = 100;
const MAX_CENTS = 5000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Deterministic, injectable clock for expiry simulation. */
export class MockClock {
  private epochMs: number;

  constructor(startIso = '2026-07-13T00:00:00.000Z') {
    this.epochMs = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.epochMs);
  }

  iso(): string {
    return this.now().toISOString();
  }

  advance(ms: number): void {
    this.epochMs += ms;
  }

  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }
}

interface MockCard {
  card_id: string;
  amount_cents: number;
  sandbox: boolean;
  state: CardSummary['state'];
  created_at: string;
  settled_cents: number;
}

/**
 * In-process test double for the agent-cards MCP (SPEC T4). Deterministic:
 * sequential ids, injectable clock, upstream behaviors verified 2026-07-07 —
 * $1–$50 clamp, auto-cancel after one authorized payment, 7-day unused expiry.
 */
export class MockUpstream implements UpstreamClient {
  readonly clock: MockClock;
  private cards = new Map<string, MockCard>();
  private txns: UpstreamTxn[] = [];
  private cardSeq = 0;
  private txnSeq = 0;

  constructor(clock = new MockClock()) {
    this.clock = clock;
  }

  private expireStaleCards(): void {
    const nowMs = this.clock.now().getTime();
    for (const card of this.cards.values()) {
      if (card.state === 'open' && nowMs - Date.parse(card.created_at) >= SEVEN_DAYS_MS) {
        card.state = 'expired';
      }
    }
  }

  private getCardOrThrow(card_id: string): MockCard {
    const card = this.cards.get(card_id);
    if (!card) throw new UpstreamError(`unknown card ${card_id}`);
    return card;
  }

  async createCard(req: { amount_cents: number; sandbox: boolean }): Promise<{ card_id: string }> {
    if (
      !Number.isInteger(req.amount_cents) ||
      req.amount_cents < MIN_CENTS ||
      req.amount_cents > MAX_CENTS
    ) {
      throw new UpstreamError(
        `amount_cents must be an integer in [${MIN_CENTS}, ${MAX_CENTS}], got ${req.amount_cents}`,
      );
    }
    this.cardSeq += 1;
    const card: MockCard = {
      card_id: `mock_card_${this.cardSeq}`,
      amount_cents: req.amount_cents,
      sandbox: req.sandbox,
      state: 'open',
      created_at: this.clock.iso(),
      settled_cents: 0,
    };
    this.cards.set(card.card_id, card);
    return { card_id: card.card_id };
  }

  async closeCard(card_id: string): Promise<void> {
    const card = this.getCardOrThrow(card_id);
    if (card.state === 'open') card.state = 'closed';
  }

  async getCardDetails(card_id: string): Promise<CardCredentials> {
    this.expireStaleCards();
    const card = this.getCardOrThrow(card_id);
    if (card.state !== 'open') {
      throw new UpstreamError(`card ${card_id} is ${card.state}; details available only while open`);
    }
    const suffix = String(this.cardSeq).padStart(4, '0');
    return {
      card_id,
      pan: `400000000000${suffix}`,
      cvv: '123',
      expiry_month: 12,
      expiry_year: this.clock.now().getUTCFullYear() + 1,
    };
  }

  async listTransactions(
    card_id: string,
    opts?: { limit?: number; status?: UpstreamTxnStatus },
  ): Promise<UpstreamTxn[]> {
    this.expireStaleCards();
    this.getCardOrThrow(card_id);
    let rows = this.txns.filter((t) => t.card_id === card_id);
    if (opts?.status) rows = rows.filter((t) => t.status === opts.status);
    if (opts?.limit !== undefined) rows = rows.slice(-opts.limit);
    return rows;
  }

  async listCards(): Promise<CardSummary[]> {
    this.expireStaleCards();
    return [...this.cards.values()].map((c) => ({
      card_id: c.card_id,
      amount_cents: c.amount_cents,
      state: c.state,
      sandbox: c.sandbox,
      created_at: c.created_at,
    }));
  }

  async checkBalance(card_id: string): Promise<{ balance_cents: number }> {
    this.expireStaleCards();
    const card = this.getCardOrThrow(card_id);
    return { balance_cents: card.amount_cents - card.settled_cents };
  }

  /**
   * Scriptable transaction feed (test helper, not part of UpstreamClient).
   * An authorization within the card limit settles and auto-cancels the card
   * (single-use); anything else declines at the "network".
   */
  simulatePurchase(
    card_id: string,
    purchase: { merchant: string; amount_cents: number; category?: string },
  ): UpstreamTxn {
    this.expireStaleCards();
    const card = this.getCardOrThrow(card_id);
    const authorized = card.state === 'open' && purchase.amount_cents <= card.amount_cents;
    this.txnSeq += 1;
    const txn: UpstreamTxn = {
      id: `mock_txn_${this.txnSeq}`,
      card_id,
      merchant: purchase.merchant,
      amount_cents: purchase.amount_cents,
      currency: 'USD',
      category: purchase.category ?? null,
      status: authorized ? 'SETTLED' : 'DECLINED',
      occurred_at: this.clock.iso(),
      raw: { simulated: true, card_state_at_purchase: card.state },
    };
    this.txns.push(txn);
    if (authorized) {
      card.settled_cents += purchase.amount_cents;
      card.state = 'used'; // auto-cancel after one authorized payment
    }
    return txn;
  }
}
