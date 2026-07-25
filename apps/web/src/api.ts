export interface Receipt {
  id: string;
  intent: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  card_id: string;
  rail: 'agentcard' | 'stripe';
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

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  total_spent_cents: number;
  receipts: number;
  blocks: number;
}

// SPEC §2.6 — mirrors PolicyRulesSchema.
export interface PolicyRules {
  allowed_merchants: string[];
  blocked_merchants: string[];
  allowed_categories: string[];
  per_card_cap_cents: number;
  per_task_budget_cents: number;
  per_merchant_caps: Record<string, number>;
  velocity: { max_cards_per_hour: number; max_amount_cents_per_day: number };
  approval_threshold_cents: number;
  card_ttl_minutes: number;
  default_rail: 'agentcard' | 'stripe';
}

export interface PolicyVersion {
  id: string;
  version: number;
  active: boolean;
  rules: PolicyRules;
  created_at: string;
}

export interface PolicyResponse {
  agent_name: string | null;
  active: PolicyVersion | null;
  versions: PolicyVersion[];
}

export class UnauthorizedError extends Error {}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
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
  agents: (token: string): Promise<{ agents: AgentSummary[] }> => request('/api/v1/agents', token),
  policies: (token: string, agentName?: string | null): Promise<PolicyResponse> =>
    request(
      `/api/v1/policies${agentName ? `?agent=${encodeURIComponent(agentName)}` : ''}`,
      token,
    ),
  putPolicy: (token: string, agentName: string | null, rules: PolicyRules): Promise<PolicyResponse> =>
    request('/api/v1/policies', token, {
      method: 'PUT',
      body: JSON.stringify({ agent_name: agentName, rules }),
    }),
};

export const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
