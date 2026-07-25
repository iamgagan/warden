import { UpstreamError } from '@warden/upstream';
import type {
  CardCredentials,
  CardSummary,
  UpstreamClient,
  UpstreamTxn,
  UpstreamTxnStatus,
} from '@warden/upstream';
import type { StripeAuthorization, StripeLike, StripeTransaction } from './stripe-like.js';

// v2: v1's cardholder omitted `individual.*` (first_name/last_name/dob/
// card_issuing.user_terms_acceptance), which Stripe requires before a card
// can activate — discovered live (see SPEC §2.8 changelog).
// v3: v2 used Date.now() inside the idempotent payload, which broke the very
// next process start (Stripe requires byte-identical params to reuse a key)
// — also discovered live. Bumping the key each time creates a fresh
// cardholder rather than colliding with a previous version's cached params.
const CARDHOLDER_IDEMPOTENCY_KEY = 'warden-default-cardholder-v3';
const METADATA_SOURCE = 'warden';

/**
 * UpstreamClient over Stripe Issuing, test mode only (SPEC §2.8). A second
 * real rail alongside AgentCard, proving the swappable-upstream boundary.
 * Exact field names on authorizations/transactions are validated by the
 * gated live E2E suite (STRIPE_E2E=1), never by CI — same discipline as
 * RealUpstream for AgentCard.
 */
export class StripeUpstream implements UpstreamClient {
  private cardholderId: string | undefined;

  constructor(private readonly stripe: StripeLike) {}

  private async cardholder(): Promise<string> {
    if (this.cardholderId) return this.cardholderId;
    const holder = await this.stripe.issuing.cardholders.create(
      {
        type: 'individual',
        name: 'Warden Agent',
        email: 'warden-agent@example.com',
        individual: {
          first_name: 'Warden',
          last_name: 'Agent',
          dob: { day: 1, month: 1, year: 1990 },
          card_issuing: {
            // Fixed, not Date.now(): this request is sent under a stable
            // idempotency key, and Stripe requires byte-identical params on
            // every retry/reuse of that key — a live timestamp here would
            // break idempotency on the very next process start (found live).
            user_terms_acceptance: {
              date: 1735689600, // 2025-01-01T00:00:00Z
              ip: '127.0.0.1',
            },
          },
        },
        billing: {
          address: {
            line1: '410 Terry Ave N',
            city: 'Seattle',
            state: 'WA',
            postal_code: '98109',
            country: 'US',
          },
        },
      },
      { idempotencyKey: CARDHOLDER_IDEMPOTENCY_KEY },
    );
    // Stripe puts every new/updated cardholder under automated review
    // (requirements.disabled_reason = 'under_review'); until it clears, every
    // authorization on their cards declines with cardholder_verification_
    // required regardless of spending limits. Stripe's own docs say this
    // normally clears "in a few seconds" — discovered live (SPEC §2.8
    // changelog) when a purchase declined despite being within the card cap.
    await this.awaitCardholderReview(holder.id);
    this.cardholderId = holder.id;
    return holder.id;
  }

  private async awaitCardholderReview(cardholderId: string, maxWaitMs = 10_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const current = await this.stripe.issuing.cardholders.retrieve(cardholderId);
      if (!current.requirements?.disabled_reason) return;
      if (Date.now() - start >= maxWaitMs) return; // proceed; caller may still see declines
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async createCard(req: { amount_cents: number; sandbox: boolean }): Promise<{ card_id: string }> {
    if (!req.sandbox) {
      throw new UpstreamError(
        'Stripe rail is test-mode only in this build; WARDEN_MODE=live is not wired for rail=stripe',
      );
    }
    const cardholder = await this.cardholder();
    const card = await this.stripe.issuing.cards.create({
      cardholder,
      type: 'virtual',
      currency: 'usd',
      status: 'active',
      spending_controls: {
        spending_limits: [{ amount: req.amount_cents, interval: 'all_time' }],
      },
      metadata: { source: METADATA_SOURCE },
    });
    return { card_id: card.id };
  }

  async closeCard(card_id: string): Promise<void> {
    await this.stripe.issuing.cards.update(card_id, { status: 'canceled' });
  }

  async getCardDetails(card_id: string): Promise<CardCredentials> {
    const card = await this.stripe.issuing.cards.retrieve(card_id, {
      expand: ['number', 'cvc'],
    });
    if (!card.number || !card.cvc) {
      throw new UpstreamError('Stripe did not return full card number/cvc for this account');
    }
    return {
      card_id,
      pan: card.number,
      cvv: card.cvc,
      expiry_month: card.exp_month,
      expiry_year: card.exp_year,
    };
  }

  async listTransactions(
    card_id: string,
    opts?: { limit?: number; status?: UpstreamTxnStatus },
  ): Promise<UpstreamTxn[]> {
    const limit = opts?.limit ?? 50;
    const [authorizations, transactions] = await Promise.all([
      this.stripe.issuing.authorizations.list({ card: card_id, limit }),
      this.stripe.issuing.transactions.list({ card: card_id, limit }),
    ]);

    const capturedAuthIds = new Set(
      transactions.data.map((t) => authorizationId(t)).filter((id): id is string => id !== null),
    );

    const fromAuths: UpstreamTxn[] = authorizations.data
      .filter((a) => !capturedAuthIds.has(a.id))
      .map((a) => ({
        id: a.id,
        card_id,
        merchant: a.merchant_data.name ?? 'unknown',
        amount_cents: a.amount,
        currency: a.currency.toUpperCase(),
        category: a.merchant_data.category ?? null,
        status: authorizationStatus(a),
        occurred_at: new Date(a.created * 1000).toISOString(),
        raw: a,
      }));

    const fromTxns: UpstreamTxn[] = transactions.data.map((t) => ({
      // Stripe models authorization and capture as separate object IDs.
      // Normalize them to the authorization ID so Warden observes one
      // transaction evolving PENDING → SETTLED instead of two purchases.
      // The native capture ID remains preserved in `raw`.
      id: authorizationId(t) ?? t.id,
      card_id,
      merchant: t.merchant_data.name ?? 'unknown',
      // Stripe's issuing.transactions.amount is signed by ledger convention
      // (negative = money left the balance, i.e. a capture; positive = a
      // refund) — found live, where a settled $18.99 purchase reported as
      // -1899. Warden's amount_cents is always a magnitude, never signed.
      amount_cents: Math.abs(t.amount),
      currency: t.currency.toUpperCase(),
      category: t.merchant_data.category ?? null,
      status: t.type === 'refund' ? 'REFUNDED' : 'SETTLED',
      occurred_at: new Date(t.created * 1000).toISOString(),
      raw: t,
    }));

    const all = [...fromAuths, ...fromTxns];
    return opts?.status ? all.filter((t) => t.status === opts.status) : all;
  }

  async listCards(): Promise<CardSummary[]> {
    const result = await this.stripe.issuing.cards.list({ limit: 100 });
    return result.data
      .filter((c) => c.metadata['source'] === METADATA_SOURCE)
      .map((c) => ({
        card_id: c.id,
        amount_cents: c.spending_controls.spending_limits.find((l) => l.interval === 'all_time')
          ?.amount ?? 0,
        state: c.status === 'canceled' ? 'closed' : 'open',
        sandbox: true,
        created_at: '',
      }));
  }

  async checkBalance(card_id: string): Promise<{ balance_cents: number }> {
    const [card, authorizations] = await Promise.all([
      this.stripe.issuing.cards.retrieve(card_id),
      this.stripe.issuing.authorizations.list({ card: card_id, limit: 100 }),
    ]);
    const cap =
      card.spending_controls.spending_limits.find((l) => l.interval === 'all_time')?.amount ?? 0;
    const spent = authorizations.data
      .filter((a) => a.approved)
      .reduce((sum, a) => sum + a.amount, 0);
    return { balance_cents: Math.max(0, cap - spent) };
  }
}

function authorizationId(t: StripeTransaction): string | null {
  const a = t.authorization;
  if (!a) return null;
  return typeof a === 'string' ? a : a.id;
}

function authorizationStatus(a: StripeAuthorization): UpstreamTxnStatus {
  if (!a.approved) return 'DECLINED';
  if (a.status === 'reversed') return 'REVERSED';
  return 'PENDING';
}

/**
 * Stripe-rail analog of MockUpstream.simulatePurchase — drives Stripe's test
 * helper API to create and (if approved) capture a test authorization. Real
 * network calls against Stripe's sandbox; only meaningful with a live test
 * client, gated by STRIPE_E2E (SPEC §2.8).
 */
export async function simulateStripePurchase(
  stripe: StripeLike,
  card_id: string,
  opts: { merchant: string; amount_cents: number },
): Promise<StripeAuthorization> {
  const auth = await stripe.testHelpers.issuing.authorizations.create({
    card: card_id,
    amount: opts.amount_cents,
    currency: 'usd',
    merchant_data: { name: opts.merchant },
  });
  if (auth.approved) {
    await stripe.testHelpers.issuing.authorizations.capture(auth.id);
  }
  return auth;
}
