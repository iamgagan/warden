import { describe, expect, it } from 'vitest';
import { StripeUpstream } from './stripe-upstream.js';
import type { StripeAuthorization, StripeCard, StripeLike, StripeTransaction } from './stripe-like.js';

function fakeStripe(): StripeLike & {
  cards: Map<string, StripeCard>;
  authorizations: StripeAuthorization[];
  transactions: StripeTransaction[];
} {
  const cards = new Map<string, StripeCard>();
  const authorizations: StripeAuthorization[] = [];
  const transactions: StripeTransaction[] = [];
  let seq = 0;

  const fake: StripeLike & {
    cards: Map<string, StripeCard>;
    authorizations: StripeAuthorization[];
    transactions: StripeTransaction[];
  } = {
    cards,
    authorizations,
    transactions,
    issuing: {
      cardholders: {
        create: async () => ({ id: 'ich_1' }),
        retrieve: async (id) => ({ id, requirements: { disabled_reason: null } }),
        list: async () => ({ data: [] }),
      },
      cards: {
        create: async (params) => {
          const id = `ic_${++seq}`;
          const card: StripeCard = {
            id,
            status: 'active',
            number: '4000000000000002',
            cvc: '123',
            exp_month: 12,
            exp_year: 2030,
            spending_controls: params['spending_controls'] as StripeCard['spending_controls'],
            metadata: (params['metadata'] as Record<string, string>) ?? {},
          };
          cards.set(id, card);
          return card;
        },
        update: async (id, params) => {
          const card = cards.get(id);
          if (!card) throw new Error('no such card');
          const updated = { ...card, ...params } as StripeCard;
          cards.set(id, updated);
          return updated;
        },
        retrieve: async (id) => {
          const card = cards.get(id);
          if (!card) throw new Error('no such card');
          return card;
        },
        list: async () => ({ data: [...cards.values()] }),
      },
      authorizations: {
        list: async (params) => ({
          data: authorizations.filter((a) => a.card === params['card']),
        }),
      },
      transactions: {
        list: async (params) => ({
          data: transactions.filter((t) => t.card === params['card']),
        }),
      },
    },
    testHelpers: {
      issuing: {
        authorizations: {
          create: async (params) => {
            const card = cards.get(params['card'] as string);
            const cap =
              card?.spending_controls.spending_limits.find((l) => l.interval === 'all_time')
                ?.amount ?? 0;
            const amount = params['amount'] as number;
            const approved = amount <= cap;
            const auth: StripeAuthorization = {
              id: `iauth_${++seq}`,
              card: params['card'] as string,
              amount,
              currency: 'usd',
              approved,
              status: 'pending',
              merchant_data: (params['merchant_data'] as StripeAuthorization['merchant_data']) ?? {},
              created: Math.floor(Date.now() / 1000),
            };
            authorizations.push(auth);
            return auth;
          },
          capture: async (id) => {
            const auth = authorizations.find((a) => a.id === id);
            if (!auth) throw new Error('no such authorization');
            auth.status = 'closed';
            transactions.push({
              id: `ipi_${++seq}`,
              card: auth.card,
              amount: -auth.amount, // Stripe signs captures negative (found live)
              currency: auth.currency,
              type: 'capture',
              authorization: auth.id,
              merchant_data: auth.merchant_data,
              created: auth.created,
            });
            return auth;
          },
        },
      },
    },
  };
  return fake;
}

describe('StripeUpstream', () => {
  it('creates a card capped at amount_cents via an all_time spending limit', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 1899, sandbox: true });
    const card = stripe.cards.get(card_id);
    expect(card?.spending_controls.spending_limits).toEqual([
      { amount: 1899, interval: 'all_time' },
    ]);
  });

  it('refuses to create a live (non-sandbox) card in this build', async () => {
    const upstream = new StripeUpstream(fakeStripe());
    await expect(upstream.createCard({ amount_cents: 1000, sandbox: false })).rejects.toThrow(
      /test-mode only/,
    );
  });

  it('closes a card by setting status canceled', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 5000, sandbox: true });
    await upstream.closeCard(card_id);
    expect(stripe.cards.get(card_id)?.status).toBe('canceled');
  });

  it('returns full card details including PAN/CVV', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 2000, sandbox: true });
    const details = await upstream.getCardDetails(card_id);
    expect(details).toEqual({
      card_id,
      pan: '4000000000000002',
      cvv: '123',
      expiry_month: 12,
      expiry_year: 2030,
    });
  });

  it('reports a settled transaction after a simulated authorized+captured purchase', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 1899, sandbox: true });
    const { simulateStripePurchase } = await import('./stripe-upstream.js');
    await simulateStripePurchase(stripe, card_id, { merchant: 'Staples', amount_cents: 1899 });

    const txns = await upstream.listTransactions(card_id);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      merchant: 'Staples',
      amount_cents: 1899,
      status: 'SETTLED',
    });
  });

  it('reports a declined authorization when the purchase exceeds the card cap', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 1000, sandbox: true });
    const { simulateStripePurchase } = await import('./stripe-upstream.js');
    await simulateStripePurchase(stripe, card_id, {
      merchant: 'sketchy-gift-cards.example',
      amount_cents: 1999,
    });

    const txns = await upstream.listTransactions(card_id);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ status: 'DECLINED', amount_cents: 1999 });
  });

  it('computes remaining balance as cap minus approved authorization amounts', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    const { card_id } = await upstream.createCard({ amount_cents: 5000, sandbox: true });
    const { simulateStripePurchase } = await import('./stripe-upstream.js');
    await simulateStripePurchase(stripe, card_id, { merchant: 'AWS', amount_cents: 1200 });

    const { balance_cents } = await upstream.checkBalance(card_id);
    expect(balance_cents).toBe(3800);
  });

  it('only lists cards Warden itself issued (filters by metadata.source)', async () => {
    const stripe = fakeStripe();
    const upstream = new StripeUpstream(stripe);
    await upstream.createCard({ amount_cents: 1000, sandbox: true });
    // A card some other integration issued on the same Stripe account.
    stripe.cards.set('ic_other', {
      id: 'ic_other',
      status: 'active',
      exp_month: 1,
      exp_year: 2030,
      spending_controls: { spending_limits: [] },
      metadata: {},
    });

    const cards = await upstream.listCards();
    expect(cards).toHaveLength(1);
  });
});
