// SPEC §3.2 — the swappable upstream boundary. RealUpstream (OAuth HTTP) and
// MockUpstream (in-process) both implement UpstreamClient; everything else in
// Warden depends only on this interface.

export type UpstreamCardState = 'open' | 'used' | 'closed' | 'expired';

export type UpstreamTxnStatus =
  | 'PENDING'
  | 'SETTLED'
  | 'DECLINED'
  | 'REVERSED'
  | 'EXPIRED'
  | 'REFUNDED';

export interface UpstreamTxn {
  id: string;
  card_id: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  status: UpstreamTxnStatus;
  occurred_at: string; // UTC ISO 8601
  raw: unknown;
}

export interface CardSummary {
  card_id: string;
  amount_cents: number;
  state: UpstreamCardState;
  sandbox: boolean;
  created_at: string; // UTC ISO 8601
}

/** PAN/CVV live in memory only; never persisted or logged (SPEC §5). */
export interface CardCredentials {
  card_id: string;
  pan: string;
  cvv: string;
  expiry_month: number;
  expiry_year: number;
}

export interface UpstreamClient {
  createCard(req: { amount_cents: number; sandbox: boolean }): Promise<{ card_id: string }>;
  closeCard(card_id: string): Promise<void>;
  getCardDetails(card_id: string): Promise<CardCredentials>;
  listTransactions(
    card_id: string,
    opts?: { limit?: number; status?: UpstreamTxnStatus },
  ): Promise<UpstreamTxn[]>;
  listCards(): Promise<CardSummary[]>;
  checkBalance(card_id: string): Promise<{ balance_cents: number }>;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code: 'UPSTREAM_ERROR' | 'UPSTREAM_AUTH_REQUIRED' = 'UPSTREAM_ERROR',
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}
