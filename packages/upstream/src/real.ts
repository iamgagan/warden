import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TokenManager } from './token-manager.js';
import {
  UpstreamError,
  type CardCredentials,
  type CardSummary,
  type UpstreamClient,
  type UpstreamTxn,
  type UpstreamTxnStatus,
} from './types.js';

export const DEFAULT_AGENTCARD_MCP_URL = 'https://mcp.agentcard.sh/mcp';

/**
 * UpstreamClient over the remote agent-cards MCP (Streamable HTTP, OAuth).
 * Access tokens live ~5 minutes, so the MCP connection is rebuilt whenever the
 * bearer token rotates. Exact result field names are validated by the gated
 * live E2E suite (AGENTCARD_E2E=1), never by CI.
 */
export class RealUpstream implements UpstreamClient {
  private readonly url: string;
  private readonly tokens: TokenManager;
  private client: Client | undefined;
  private connectedWithToken: string | undefined;
  private instructionsLogged = false;

  constructor(opts: { url?: string; tokenManager: TokenManager }) {
    this.url = opts.url ?? DEFAULT_AGENTCARD_MCP_URL;
    this.tokens = opts.tokenManager;
  }

  private async connectedClient(accessToken: string): Promise<Client> {
    if (this.client && this.connectedWithToken === accessToken) return this.client;
    if (this.client) await this.client.close().catch(() => undefined);
    const client = new Client({ name: 'warden', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    this.client = client;
    this.connectedWithToken = accessToken;
    if (!this.instructionsLogged) {
      this.instructionsLogged = true;
      // AgentCard asks clients to fetch current usage guidance once at startup.
      // Log, never act on it (SPEC §5).
      void this.rawCall(client, 'get_instructions', {})
        .then((r) => console.error('[warden] agent-cards get_instructions:', truncate(r)))
        .catch(() => undefined);
    }
    return client;
  }

  private async rawCall(client: Client, name: string, args: object): Promise<unknown> {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    if (result.isError) {
      const text = contentText(result.content);
      if (/\b401\b|unauthorized/i.test(text)) {
        throw new UpstreamError(`upstream ${name}: ${text}`, 'UPSTREAM_AUTH_REQUIRED');
      }
      throw new UpstreamError(`upstream ${name} failed: ${text}`);
    }
    const text = contentText(result.content);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async call(name: string, args: object): Promise<unknown> {
    return this.tokens.withAuth(async (token) => {
      const client = await this.connectedClient(token);
      try {
        return await this.rawCall(client, name, args);
      } catch (err) {
        // A dead connection must not be reused after the token refresh retry.
        if (err instanceof UpstreamError && err.code === 'UPSTREAM_AUTH_REQUIRED') {
          this.connectedWithToken = undefined;
        }
        throw err;
      }
    });
  }

  async createCard(req: { amount_cents: number; sandbox: boolean }): Promise<{ card_id: string }> {
    const result = asRecord(await this.call('create_card', req), 'create_card');
    const cardId = result['card_id'] ?? result['id'];
    if (typeof cardId !== 'string') {
      throw new UpstreamError('create_card response missing card_id');
    }
    return { card_id: cardId };
  }

  async closeCard(card_id: string): Promise<void> {
    await this.call('close_card', { card_id });
  }

  async getCardDetails(card_id: string): Promise<CardCredentials> {
    const r = asRecord(await this.call('get_card_details', { card_id }), 'get_card_details');
    return {
      card_id,
      pan: str(r, ['pan', 'number', 'card_number']),
      cvv: str(r, ['cvv', 'cvc']),
      expiry_month: num(r, ['expiry_month', 'exp_month']),
      expiry_year: num(r, ['expiry_year', 'exp_year']),
    };
  }

  async listTransactions(
    card_id: string,
    opts?: { limit?: number; status?: UpstreamTxnStatus },
  ): Promise<UpstreamTxn[]> {
    const result = await this.call('list_transactions', { card_id, ...opts });
    const rows = asArray(result, 'transactions');
    return rows.map((row) => {
      const r = asRecord(row, 'transaction');
      return {
        id: str(r, ['id', 'transaction_id', 'txn_id']),
        card_id,
        merchant: strOr(r, ['merchant', 'merchant_name'], 'unknown'),
        amount_cents: num(r, ['amount_cents', 'amount']),
        currency: strOr(r, ['currency'], 'USD'),
        category: (r['category'] as string | undefined) ?? null,
        status: (strOr(r, ['status'], 'PENDING').toUpperCase() as UpstreamTxnStatus),
        occurred_at: strOr(r, ['occurred_at', 'created_at', 'timestamp'], new Date().toISOString()),
        raw: row,
      };
    });
  }

  async listCards(): Promise<CardSummary[]> {
    const result = await this.call('list_cards', {});
    return asArray(result, 'cards').map((row) => {
      const r = asRecord(row, 'card');
      return {
        card_id: str(r, ['card_id', 'id']),
        amount_cents: num(r, ['amount_cents', 'amount']),
        state: (strOr(r, ['state', 'status'], 'open').toLowerCase() as CardSummary['state']),
        sandbox: Boolean(r['sandbox']),
        created_at: strOr(r, ['created_at'], ''),
      };
    });
  }

  async checkBalance(card_id: string): Promise<{ balance_cents: number }> {
    const r = asRecord(await this.call('check_balance', { card_id }), 'check_balance');
    return { balance_cents: num(r, ['balance_cents', 'balance']) };
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
    .join('\n')
    .trim();
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new UpstreamError(`unexpected ${context} response shape`);
}

function asArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function str(r: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof r[k] === 'string') return r[k] as string;
  throw new UpstreamError(`response missing one of: ${keys.join(', ')}`);
}

function strOr(r: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const k of keys) if (typeof r[k] === 'string') return r[k] as string;
  return fallback;
}

function num(r: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) if (typeof r[k] === 'number') return r[k] as number;
  throw new UpstreamError(`response missing numeric field: ${keys.join(', ')}`);
}

function truncate(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
