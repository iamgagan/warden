#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import { formatAuthStatus, runAuthFlow } from './auth.js';

const credentialsPath =
  process.env['WARDEN_CREDENTIALS_PATH'] ?? join(homedir(), '.warden', 'credentials.json');

const usage = `warden — spend guardrails + receipts for AI agents

Usage:
  warden auth            Interactive AgentCard login (browser PKCE flow, once)
  warden auth --status   Show stored credential state
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'auth' && rest[0] === '--status') {
    console.log(formatAuthStatus(credentialsPath));
    return;
  }
  if (command === 'auth') {
    await runAuthFlow({
      credentialsPath,
      mcpUrl: process.env['AGENTCARD_MCP_URL'],
      openBrowser: async (url) => {
        await open(url);
      },
      log: (line) => console.log(line),
    });
    return;
  }
  console.log(usage);
  if (command !== undefined && command !== 'help' && command !== '--help') {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
