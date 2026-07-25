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
        'Start a spend task for an agent. Requires the intent (the human goal/prompt that triggered this task); returns a budget envelope. No card is minted here.',
      inputSchema: {
        agent_name: z.string().min(1),
        intent: z.string().min(1),
        budget_cents: z.number().int().positive().optional(),
      },
    },
    async (args) => run(() => service.startTask(args)),
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
      },
    },
    async (args) => run(() => service.issueCard(args)),
  );

  server.registerTool(
    'warden_precheck_purchase',
    {
      description:
        'Advisory-only check: would this purchase be allowed under the active policy right now? Never mints a card or changes state; useful for an agent to sanity-check before spending effort on a purchase flow.',
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
        'Complete a task: closes all still-open cards upstream, releases unused budget, returns totals.',
      inputSchema: { task_id: z.string().min(1) },
    },
    async (args) => run(() => service.completeTask(args)),
  );

  return server;
}
