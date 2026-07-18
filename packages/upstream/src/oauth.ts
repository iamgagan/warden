import { createHash, randomBytes } from 'node:crypto';
import { UpstreamError } from './types.js';

// SPEC §2.7 — OAuth 2.0 authorization code + PKCE with dynamic client
// registration, discovered via /.well-known/oauth-authorization-server.

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type FetchFn = typeof fetch;

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function discoverAuthServer(
  mcpUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<AuthServerMetadata> {
  const origin = new URL(mcpUrl).origin;
  const res = await fetchFn(`${origin}/.well-known/oauth-authorization-server`);
  if (!res.ok) {
    throw new UpstreamError(`auth server discovery failed: HTTP ${res.status}`);
  }
  const meta = (await res.json()) as Partial<AuthServerMetadata>;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new UpstreamError('auth server metadata missing authorization/token endpoints');
  }
  return meta as AuthServerMetadata;
}

/** Dynamic client registration (public client, no secret). Returns client_id. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const res = await fetchFn(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'warden',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    throw new UpstreamError(`dynamic client registration failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new UpstreamError('registration response missing client_id');
  return body.client_id;
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<TokenResponse> {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new UpstreamError(`token request rejected: HTTP ${res.status}`, 'UPSTREAM_AUTH_REQUIRED');
  }
  if (!res.ok) throw new UpstreamError(`token request failed: HTTP ${res.status}`);
  const body = (await res.json()) as Partial<TokenResponse>;
  if (!body.access_token) throw new UpstreamError('token response missing access_token');
  return body as TokenResponse;
}

export async function exchangeCode(
  input: {
    tokenEndpoint: string;
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    input.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    fetchFn,
  );
}

export async function refreshAccessToken(
  input: { tokenEndpoint: string; clientId: string; refreshToken: string },
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    input.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    },
    fetchFn,
  );
}
