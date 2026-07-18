// SPEC §3.1 — machine-readable error codes returned as MCP tool errors.
export type WardenErrorCode =
  | 'POLICY_BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_PENDING'
  | 'TASK_NOT_ACTIVE'
  | 'BUDGET_EXCEEDED'
  | 'CIRCUIT_OPEN'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_AUTH_REQUIRED';

export class WardenToolError extends Error {
  constructor(
    readonly code: WardenErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WardenToolError';
  }

  toPayload(): { code: WardenErrorCode; message: string } & Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}
