// The narrow slice of the real `stripe` SDK that StripeUpstream depends on.
// Production code passes a real `Stripe` client (structurally compatible,
// cast once at the wiring point in packages/mcp); tests pass a hand-rolled
// fake. Keeps this package's tests offline per SPEC §5 ("no test may require
// network access... by default").

export interface StripeCardholder {
  id: string;
  requirements?: { disabled_reason: string | null };
}

export interface StripeSpendingLimit {
  amount: number;
  interval: string;
}

export interface StripeCard {
  id: string;
  status: string;
  number?: string;
  cvc?: string;
  exp_month: number;
  exp_year: number;
  spending_controls: { spending_limits: StripeSpendingLimit[] };
  metadata: Record<string, string>;
}

export interface StripeAuthorization {
  id: string;
  card: string;
  amount: number;
  currency: string;
  approved: boolean;
  status: string; // 'pending' | 'closed' | 'reversed'
  merchant_data: { name?: string; category?: string };
  created: number; // unix seconds
}

export interface StripeTransaction {
  id: string;
  card: string;
  amount: number;
  currency: string;
  type: string; // 'capture' | 'refund'
  authorization?: string | { id: string } | null;
  merchant_data: { name?: string; category?: string };
  created: number;
}

export interface StripeList<T> {
  data: T[];
}

export interface StripeLike {
  issuing: {
    cardholders: {
      create(
        params: Record<string, unknown>,
        options?: { idempotencyKey?: string },
      ): Promise<StripeCardholder>;
      retrieve(id: string): Promise<StripeCardholder>;
      list(params: Record<string, unknown>): Promise<StripeList<StripeCardholder>>;
    };
    cards: {
      create(params: Record<string, unknown>): Promise<StripeCard>;
      update(id: string, params: Record<string, unknown>): Promise<StripeCard>;
      retrieve(id: string, params?: Record<string, unknown>): Promise<StripeCard>;
      list(params: Record<string, unknown>): Promise<StripeList<StripeCard>>;
    };
    authorizations: {
      list(params: Record<string, unknown>): Promise<StripeList<StripeAuthorization>>;
    };
    transactions: {
      list(params: Record<string, unknown>): Promise<StripeList<StripeTransaction>>;
    };
  };
  testHelpers: {
    issuing: {
      authorizations: {
        create(params: Record<string, unknown>): Promise<StripeAuthorization>;
        capture(id: string, params?: Record<string, unknown>): Promise<StripeAuthorization>;
      };
    };
  };
}
