export type Rail = 'auto' | 'agentcard' | 'stripe';
export type MandateStatus = 'draft' | 'active' | 'exhausted' | 'revoked' | 'expired';

export interface Mandate {
  id: string;
  status: MandateStatus;
  agent_id: string;
  agent: string;
  task_id: string | null;
  purpose: string;
  merchant: string;
  currency: string;
  amount_limit_cents: number;
  per_transaction_limit_cents: number;
  max_transactions: number;
  transaction_count: number;
  reserved_cents: number;
  settled_cents: number;
  amount_available_cents: number;
  rail: Rail;
  policy_id: string | null;
  policy_snapshot_hash: string | null;
  mandate_hash: string | null;
  approved_by: string | null;
  created_at: string;
  activated_at: string | null;
  expires_at: string;
  closed_at: string | null;
  close_reason: string | null;
  summary: string;
}

export interface CreateMandateInput {
  agent_name: string;
  purpose: string;
  merchant: string;
  amount_limit_cents: number;
  per_transaction_limit_cents?: number;
  max_transactions: number;
  expires_at: string;
  rail: Rail;
  activate_now: boolean;
}

export interface EvidenceCheck {
  code: string;
  result: 'pass' | 'fail';
  explanation: string;
}

export interface Evidence {
  id: string;
  receipt_id: string;
  mandate_id: string;
  authorization_id: string | null;
  transaction_id: string;
  outcome: 'pending' | 'settled' | 'declined' | 'reversed' | 'refunded' | 'violation';
  decision: 'matched' | 'mismatch' | 'unknown';
  checks: EvidenceCheck[];
  mandate: Record<string, unknown>;
  authorization: Record<string, unknown> | null;
  transaction: Record<string, unknown>;
  merchant: string;
  amount_cents: number;
  currency: string;
  agent: string;
  purpose: string;
  integrity: {
    kind: 'sha256_chain_v1';
    sequence: number;
    evidence_hash: string;
    previous_hash: string | null;
    verified: boolean;
  };
  created_at: string;
}

export interface Receipt {
  id: string;
  intent: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  category: string | null;
  card_id: string;
  rail: Exclude<Rail, 'auto'>;
  task_id: string;
  policy_id: string | null;
  mandate_id: string | null;
  evidence_hash: string | null;
  evidence_outcome: Evidence['outcome'] | null;
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
  active_mandates: number;
  authority_available_cents: number;
  evidence_total: number;
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
  default_rail: Exclude<Rail, 'auto'>;
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
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new UnauthorizedError('invalid token');
  const body = (await res.json().catch(() => null)) as
    | T
    | { error?: { message?: string } }
    | null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? body.error?.message
        : undefined;
    throw new Error(message || `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  health: (): Promise<Health> => fetch('/healthz').then((r) => r.json() as Promise<Health>),
  mandates: (token: string): Promise<{ mandates: Mandate[] }> =>
    request('/api/v1/mandates', token),
  createMandate: (
    token: string,
    input: CreateMandateInput,
  ): Promise<{ mandate: Mandate }> =>
    request('/api/v1/mandates', token, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  activateMandate: (token: string, id: string): Promise<{ mandate: Mandate }> =>
    request(`/api/v1/mandates/${id}/activate`, token, { method: 'POST' }),
  revokeMandate: (
    token: string,
    id: string,
    reason: string,
  ): Promise<{ mandate: Mandate }> =>
    request(`/api/v1/mandates/${id}/revoke`, token, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  evidence: (token: string, limit = 100): Promise<{ evidence: Evidence[] }> =>
    request(`/api/v1/evidence?limit=${limit}`, token),
  receipts: (token: string, limit = 100): Promise<{ receipts: Receipt[] }> =>
    request(`/api/v1/receipts?limit=${limit}`, token),
  receipt: (token: string, id: string): Promise<ReceiptDetail> =>
    request(`/api/v1/receipts/${id}`, token),
  stats: (token: string): Promise<Stats> => request('/api/v1/stats', token),
  agents: (token: string): Promise<{ agents: AgentSummary[] }> =>
    request('/api/v1/agents', token),
  policies: (token: string, agentName?: string | null): Promise<PolicyResponse> =>
    request(
      `/api/v1/policies${agentName ? `?agent=${encodeURIComponent(agentName)}` : ''}`,
      token,
    ),
  putPolicy: (
    token: string,
    agentName: string | null,
    rules: PolicyRules,
  ): Promise<PolicyResponse> =>
    request('/api/v1/policies', token, {
      method: 'PUT',
      body: JSON.stringify({ agent_name: agentName, rules }),
    }),
};

export const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
