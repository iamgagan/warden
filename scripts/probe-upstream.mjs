// One-off probe: dump the raw MCP result of create_card / list_cards so the
// RealUpstream mappers can be aligned with reality. Safe tools only — never
// probes get_card_details raw (PAN/CVV must not hit stdout).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../packages/upstream/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../packages/upstream/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { TokenManager } from '../packages/upstream/dist/index.js';

const tokens = new TokenManager({
  credentialsPath: join(homedir(), '.warden', 'credentials.json'),
});
const accessToken = await tokens.forceRefresh();
const client = new Client({ name: 'warden-probe', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://mcp.agentcard.sh/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  }),
);

const dump = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} isError=${r.isError ?? false}`);
  for (const c of r.content ?? []) {
    console.log(c.type === 'text' ? c.text.slice(0, 1500) : `[${c.type}]`);
  }
  if (r.structuredContent) console.log('structured:', JSON.stringify(r.structuredContent).slice(0, 1500));
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

await dump('create_card', { amount_cents: 100, sandbox: true });
await dump('list_cards', {});
await client.close();
