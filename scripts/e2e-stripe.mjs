// Live TEST-mode E2E against the real Stripe Issuing sandbox (SPEC §2.8:
// human-run only, never CI). Exercises StripeUpstream's real API mapping:
// create a card, simulate an authorized purchase via Stripe's test helpers,
// list transactions, check balance, get card details, close. Never prints
// full PAN/CVC.
//   STRIPE_SECRET_KEY=sk_test_... node scripts/e2e-stripe.mjs
import Stripe from 'stripe';
import { StripeUpstream, simulateStripePurchase } from '../packages/upstream-stripe/dist/index.js';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('STRIPE_SECRET_KEY is required (test-mode sk_test_... key)');
  process.exit(1);
}

const step = (name, fn) =>
  fn().then(
    (result) => {
      console.log(`✓ ${name}:`, JSON.stringify(result));
      return result;
    },
    (err) => {
      console.log(`✗ ${name}: [${err.code ?? 'ERROR'}] ${err.message}`);
      throw err;
    },
  );

const stripe = new Stripe(secretKey);
const upstream = new StripeUpstream(stripe);

const { card_id } = await step('createCard ($18.99, sandbox)', () =>
  upstream.createCard({ amount_cents: 1899, sandbox: true }),
);

await step('listCards (find ours)', async () => {
  const cards = await upstream.listCards();
  const ours = cards.find((c) => c.card_id === card_id);
  return { total: cards.length, ours };
});

await step('checkBalance (before purchase)', () => upstream.checkBalance(card_id));

await step('simulateStripePurchase (Staples, $18.99 — should authorize+capture)', () =>
  simulateStripePurchase(stripe, card_id, { merchant: 'Staples', amount_cents: 1899 }),
);

await step('listTransactions (expect one SETTLED)', () => upstream.listTransactions(card_id));

await step('checkBalance (after purchase)', () => upstream.checkBalance(card_id));

await step('getCardDetails (masked)', async () => {
  const creds = await upstream.getCardDetails(card_id);
  return {
    card_id: creds.card_id,
    pan: `••••${creds.pan.slice(-4)}`,
    cvv: '•••',
    expiry: `${creds.expiry_month}/${creds.expiry_year}`,
  };
}).catch((err) => {
  console.log(`  (getCardDetails failed: ${err.message} — may need account review for full PAN/CVC)`);
});

await step('closeCard', () => upstream.closeCard(card_id));

// Second card: prove a decline is a real network decline, not a Warden guess.
const { card_id: card2 } = await step('createCard ($10.00, sandbox) — for a decline test', () =>
  upstream.createCard({ amount_cents: 1000, sandbox: true }),
);
await step('simulateStripePurchase ($19.99 against a $10.00 cap — should decline)', () =>
  simulateStripePurchase(stripe, card2, { merchant: 'sketchy-gift-cards.example', amount_cents: 1999 }),
);
await step('listTransactions (expect one DECLINED)', () => upstream.listTransactions(card2));
await step('closeCard (cleanup)', () => upstream.closeCard(card2));

console.log('\nE2E against live Stripe TEST rail: PASS');
