import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  DEFAULT_AGENTCARD_MCP_URL,
  TokenManager,
  buildAuthorizationUrl,
  discoverAuthServer,
  exchangeCode,
  generatePkce,
  readCredentials,
  registerClient,
  UpstreamError,
} from '@warden/upstream';

/**
 * The ONLY interactive code path in the repo (SPEC §5): browser PKCE flow via
 * a localhost callback, run by a human exactly once. Everything else uses the
 * stored refresh token headlessly.
 */
export async function runAuthFlow(opts: {
  credentialsPath: string;
  mcpUrl?: string;
  openBrowser: (url: string) => Promise<void>;
  log: (line: string) => void;
}): Promise<void> {
  const mcpUrl = opts.mcpUrl ?? DEFAULT_AGENTCARD_MCP_URL;
  const meta = await discoverAuthServer(mcpUrl);

  const { server, port, waitForCallback } = await startCallbackServer();
  try {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    if (!meta.registration_endpoint) {
      throw new UpstreamError('auth server does not offer dynamic client registration');
    }
    const clientId = await registerClient(meta.registration_endpoint, redirectUri);
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');
    const authUrl = buildAuthorizationUrl({
      authorizationEndpoint: meta.authorization_endpoint,
      clientId,
      redirectUri,
      challenge,
      state,
    });

    opts.log('Opening browser for AgentCard login…');
    opts.log(`If it does not open, visit:\n  ${authUrl}`);
    await opts.openBrowser(authUrl);

    const callback = await waitForCallback;
    if (callback.state !== state) {
      throw new UpstreamError('OAuth state mismatch; aborting');
    }

    const tokens = await exchangeCode({
      tokenEndpoint: meta.token_endpoint,
      clientId,
      code: callback.code,
      verifier,
      redirectUri,
    });

    const manager = new TokenManager({ credentialsPath: opts.credentialsPath });
    manager.saveInitial({
      token_endpoint: meta.token_endpoint,
      authorization_endpoint: meta.authorization_endpoint,
      client_id: clientId,
    });
    manager.applyTokenResponse(tokens);

    opts.log(`Authenticated. Credentials stored at ${opts.credentialsPath} (chmod 600).`);
    opts.log(
      tokens.refresh_token
        ? 'Refresh token saved; all Warden services can now run headlessly.'
        : 'WARNING: no refresh token returned; headless refresh will not work.',
    );
  } finally {
    server.close();
  }
}

export function formatAuthStatus(credentialsPath: string, now = Date.now()): string {
  const creds = readCredentials(credentialsPath);
  if (!creds) return `not authenticated (no credentials at ${credentialsPath}); run \`warden auth\``;
  const lines = [
    `credentials:    ${credentialsPath}`,
    `client_id:      ${creds.client_id}`,
    `token endpoint: ${creds.token_endpoint}`,
    `refresh token:  ${creds.refresh_token ? 'present' : 'MISSING — run `warden auth`'}`,
  ];
  if (creds.access_token && creds.access_token_expires_at) {
    const msLeft = Date.parse(creds.access_token_expires_at) - now;
    lines.push(
      msLeft > 0
        ? `access token:   live, expires in ${Math.round(msLeft / 1000)}s`
        : 'access token:   expired (will refresh on next use)',
    );
  } else {
    lines.push('access token:   none yet (will be fetched on first use)');
  }
  return lines.join('\n');
}

interface CallbackResult {
  code: string;
  state: string;
}

async function startCallbackServer(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  waitForCallback: Promise<CallbackResult>;
}> {
  let resolveCallback!: (r: CallbackResult) => void;
  let rejectCallback!: (e: Error) => void;
  const waitForCallback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (error || !code || !state) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<h3>Warden: login failed. You can close this tab.</h3>');
      rejectCallback(new UpstreamError(`authorization failed: ${error ?? 'missing code/state'}`));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h3>Warden: login complete. You can close this tab and return to the terminal.</h3>');
    resolveCallback({ code, state });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new UpstreamError('failed to bind localhost callback listener');
  }
  return { server, port: address.port, waitForCallback };
}
