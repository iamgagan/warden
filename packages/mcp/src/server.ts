import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WardenToolError } from './errors.js';
import type { WardenService } from './service.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const fail = (err: unknown): ToolResult => {
  const payload =
    err instanceof WardenToolError
      ? err.toPayload()
      : { code: 'UPSTREAM_ERROR', message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
};

const run = async (fn: () => Promise<unknown> | unknown): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
};

/** warden-mcp — the MCP surface the agent talks to instead of agent-cards. */
export function createWardenMcpServer(service: WardenService): McpServer {
  const server = new McpServer({ name: 'warden', version: '0.1.0' });

  server.registerTool(
    'warden_start_task',
    {
      description:
        'Compatibility-only self-declared task flow. Disabled unless the operator explicitly sets WARDEN_ALLOW_LEGACY_TASKS=true; new integrations should use warden_start_mandate_task.',
      inputSchema: {
        agent_name: z.string().min(1),
        intent: z.string().min(1),
        budget_cents: z.number().int().positive().optional(),
      },
    },
    async (args) => run(() => service.startTask(args)),
  );

  server.registerTool(
    'warden_list_my_mandates',
    {
      description:
        'List active operator-approved mandates delegated to the agent identity bound to this MCP process. Use this to discover authority without copying IDs into prompts.',
      inputSchema: {},
    },
    async () => run(() => service.listMyMandates()),
  );

  server.registerTool(
    'warden_start_mandate_task',
    {
      description:
        'Load an active operator-approved spend mandate for the agent identity bound to this MCP process. Returns its task, exact payee, remaining authority, expiry, and policy summary. The agent cannot self-declare either identity or terms.',
      inputSchema: {
        mandate_id: z.string().min(1),
      },
    },
    async (args) => run(() => service.startMandateTask(args)),
  );

  server.registerTool(
    'warden_issue_card',
    {
      description:
        'Mint one single-use scoped card for one purchase inside a task. Policy is evaluated deterministically; the card amount is enforced at the card network. Optionally choose which card rail issues it (defaults to the policy\'s default_rail).',
      inputSchema: {
        task_id: z.string().min(1),
        amount_cents: z.number().int().positive(),
        merchant: z.string().optional(),
        category: z.string().optional(),
        rail: z.enum(['agentcard', 'stripe']).optional(),
        idempotency_key: z
          .string()
          .min(1)
          .optional()
          .describe('Required for mandate tasks; reuse the same key when retrying the same checkout.'),
      },
    },
    async (args) => run(() => service.issueCard(args)),
  );

  server.registerTool(
    'warden_precheck_purchase',
    {
      description:
        'Advisory-only check against both the operator mandate and active policy. Never mints a card or reserves authority.',
      inputSchema: {
        task_id: z.string().min(1),
        merchant: z.string().min(1),
        amount_cents: z.number().int().positive(),
        category: z.string().optional(),
      },
    },
    async (args) => run(() => service.precheckPurchase(args)),
  );

  server.registerTool(
    'warden_get_card_details',
    {
      description:
        'Get PAN/CVV/expiry for an open card on an active task (pass-through; Warden never stores credentials).',
      inputSchema: { card_id: z.string().min(1) },
    },
    async (args) => run(() => service.getCardDetails(args)),
  );

  server.registerTool(
    'warden_complete_task',
    {
      description:
        'Complete a legacy task. Mandate tasks are controlled by the operator and remain open until revoked, expired, or exhausted.',
      inputSchema: { task_id: z.string().min(1) },
    },
    async (args) => run(() => service.completeTask(args)),
  );

  return server;
}
