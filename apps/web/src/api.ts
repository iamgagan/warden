export interface Receipt {
  id: string;
  intent: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  card_id: string;
  task_id: string;
  policy_id: string | null;
  agent: string;
  transaction_status: string;
  occurred_at: string;
  created_at: string;
  decision_summary: string;
}

export interface ReceiptDetail extends Receipt {
  decision: Record<string, unknown>;
}

export interface Stats {
  spend_under_management_cents: number;
  receipts_total: number;
  blocks_total: number;
  avg_blast_radius_cents: number;
}

export interface Health {
  ok: boolean;
  mode: 'test' | 'live';
  upstream_auth: 'ok' | 'needs_login';
}

export class UnauthorizedError extends Error {}

async function request<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new UnauthorizedError('invalid token');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  health: (): Promise<Health> => fetch('/healthz').then((r) => r.json() as Promise<Health>),
  receipts: (token: string, limit = 100): Promise<{ receipts: Receipt[] }> =>
    request(`/api/v1/receipts?limit=${limit}`, token),
  receipt: (token: string, id: string): Promise<ReceiptDetail> =>
    request(`/api/v1/receipts/${id}`, token),
  stats: (token: string): Promise<Stats> => request('/api/v1/stats', token),
};

export const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
