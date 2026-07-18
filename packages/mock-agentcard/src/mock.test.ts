import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@warden/upstream';
import { MockClock, MockUpstream } from './mock.js';

describe('MockUpstream', () => {
  it('enforces the $1–$50 clamp on card creation', async () => {
    const mock = new MockUpstream();
    await expect(mock.createCard({ amount_cents: 99, sandbox: true })).rejects.toThrow(
      UpstreamError,
    );
    await expect(mock.createCard({ amount_cents: 5001, sandbox: true })).rejects.toThrow(
      UpstreamError,
    );
    await expect(mock.createCard({ amount_cents: 100.5, sandbox: true })).rejects.toThrow();
    const { card_id } = await mock.createCard({ amount_cents: 5000, sandbox: true });
    expect(card_id).toBe('mock_card_1');
  });

  it('auto-cancels a card after one authorized payment (single-use)', async () => {
    const mock = new MockUpstream();
    const { card_id } = await mock.createCard({ amount_cents: 2000, sandbox: true });
    const settled = mock.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1500 });
    expect(settled.status).toBe('SETTLED');
    expect((await mock.listCards())[0]?.state).toBe('used');
    // second attempt on the same card declines at the "network"
    const declined = mock.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 100 });
    expect(declined.status).toBe('DECLINED');
    expect(await mock.checkBalance(card_id)).toEqual({ balance_cents: 500 });
  });

  it('declines over-limit authorizations and keeps the card open', async () => {
    const mock = new MockUpstream();
    const { card_id } = await mock.createCard({ amount_cents: 1000, sandbox: true });
    const declined = mock.simulatePurchase(card_id, { merchant: 'apple', amount_cents: 1001 });
    expect(declined.status).toBe('DECLINED');
    expect((await mock.listCards())[0]?.state).toBe('open');
  });

  it('expires unused cards after 7 days via the injectable clock', async () => {
    const clock = new MockClock('2026-07-13T00:00:00.000Z');
    const mock = new MockUpstream(clock);
    const { card_id } = await mock.createCard({ amount_cents: 1000, sandbox: true });
    clock.advanceDays(6);
    expect((await mock.listCards())[0]?.state).toBe('open');
    clock.advanceDays(1);
    expect((await mock.listCards())[0]?.state).toBe('expired');
    const declined = mock.simulatePurchase(card_id, { merchant: 'apple', amount_cents: 500 });
    expect(declined.status).toBe('DECLINED');
  });

  it('closeCard is idempotent and only closes open cards', async () => {
    const mock = new MockUpstream();
    const { card_id } = await mock.createCard({ amount_cents: 1000, sandbox: true });
    mock.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1000 });
    await mock.closeCard(card_id); // already used; stays used
    expect((await mock.listCards())[0]?.state).toBe('used');
    const second = await mock.createCard({ amount_cents: 1000, sandbox: true });
    await mock.closeCard(second.card_id);
    await mock.closeCard(second.card_id);
    expect((await mock.listCards())[1]?.state).toBe('closed');
  });

  it('serves card details only while open, never after', async () => {
    const mock = new MockUpstream();
    const { card_id } = await mock.createCard({ amount_cents: 1000, sandbox: true });
    const creds = await mock.getCardDetails(card_id);
    expect(creds.pan).toMatch(/^4\d{15}$/);
    mock.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1000 });
    await expect(mock.getCardDetails(card_id)).rejects.toThrow(/used/);
  });

  it('filters transactions by status and limit', async () => {
    const mock = new MockUpstream();
    const { card_id } = await mock.createCard({ amount_cents: 1000, sandbox: true });
    mock.simulatePurchase(card_id, { merchant: 'a', amount_cents: 2000 }); // DECLINED
    mock.simulatePurchase(card_id, { merchant: 'b', amount_cents: 900 }); // SETTLED
    mock.simulatePurchase(card_id, { merchant: 'c', amount_cents: 100 }); // DECLINED (used)
    expect(await mock.listTransactions(card_id)).toHaveLength(3);
    expect(await mock.listTransactions(card_id, { status: 'SETTLED' })).toHaveLength(1);
    expect(await mock.listTransactions(card_id, { limit: 2 })).toHaveLength(2);
    await expect(mock.listTransactions('nope')).rejects.toThrow(/unknown card/);
  });

  it('is deterministic across instances', async () => {
    const run = async () => {
      const mock = new MockUpstream(new MockClock('2026-07-13T00:00:00.000Z'));
      const { card_id } = await mock.createCard({ amount_cents: 1500, sandbox: true });
      const txn = mock.simulatePurchase(card_id, { merchant: 'staples', amount_cents: 1200 });
      return { card_id, txn };
    };
    expect(await run()).toEqual(await run());
  });
});
