// Live TEST-mode E2E against the real agent-cards MCP (SPEC: human-run only,
// never CI). Exercises RealUpstream's OAuth + response mapping: create a $1
// sandbox card, list, balance, transactions, close. Never prints PAN/CVV.
//   node scripts/e2e-real.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RealUpstream, TokenManager } from '../packages/upstream/dist/index.js';

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

const upstream = new RealUpstream({
  tokenManager: new TokenManager({
    credentialsPath: join(homedir(), '.warden', 'credentials.json'),
  }),
});

const { card_id } = await step('create_card ($1.00, sandbox)', () =>
  upstream.createCard({ amount_cents: 100, sandbox: true }),
);

await step('list_cards (find ours)', async () => {
  const cards = await upstream.listCards();
  const ours = cards.find((c) => c.card_id === card_id);
  return { total: cards.length, ours };
});

await step('check_balance', () => upstream.checkBalance(card_id));

await step('list_transactions (expect empty)', () => upstream.listTransactions(card_id));

await step('get_card_details (masked)', async () => {
  const creds = await upstream.getCardDetails(card_id);
  return {
    card_id: creds.card_id,
    pan: `••••${creds.pan.slice(-4)}`,
    cvv: '•••',
    expiry: `${creds.expiry_month}/${creds.expiry_year}`,
  };
}).catch(() => {
  console.log('  (get_card_details may require upstream human approval — acceptable)');
});

await step('close_card', () => upstream.closeCard(card_id));

await step('list_cards (ours now closed)', async () => {
  const cards = await upstream.listCards();
  return cards.find((c) => c.card_id === card_id);
});

console.log('\nE2E against live TEST rail: PASS');
