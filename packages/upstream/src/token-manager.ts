import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { refreshAccessToken, type FetchFn, type TokenResponse } from './oauth.js';
import { UpstreamError } from './types.js';

/**
 * Persisted at WARDEN_CREDENTIALS_PATH (chmod 600), written by `warden auth`.
 * Never copied from other tools' config files (SPEC §5).
 */
export interface StoredCredentials {
  token_endpoint: string;
  authorization_endpoint: string;
  client_id: string;
  access_token?: string;
  access_token_expires_at?: string; // UTC ISO 8601
  refresh_token?: string;
  account?: string;
}

export function readCredentials(path: string): StoredCredentials | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials;
}

export function writeCredentials(path: string, creds: StoredCredentials): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // in case the file pre-existed with wider permissions
}

const REFRESH_MARGIN_MS = 60_000; // refresh when <60s of life remains

/**
 * Owns the stored refresh token and hands out live access tokens
 * (~5-minute upstream lifetime; refreshed proactively). Headless-only:
 * with no refresh token it fails UPSTREAM_AUTH_REQUIRED, never prompts.
 */
export class TokenManager {
  private readonly path: string;
  private readonly fetchFn: FetchFn;
  private readonly nowMs: () => number;
  private creds: StoredCredentials | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(opts: { credentialsPath: string; fetchFn?: FetchFn; now?: () => number }) {
    this.path = opts.credentialsPath;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.nowMs = opts.now ?? Date.now;
    this.creds = readCredentials(this.path);
  }

  get credentials(): StoredCredentials | undefined {
    return this.creds;
  }

  /** Called by `warden auth` after the interactive PKCE flow. */
  saveInitial(creds: StoredCredentials): void {
    this.creds = creds;
    writeCredentials(this.path, creds);
  }

  private tokenIsFresh(): boolean {
    if (!this.creds?.access_token || !this.creds.access_token_expires_at) return false;
    return Date.parse(this.creds.access_token_expires_at) - this.nowMs() > REFRESH_MARGIN_MS;
  }

  async getAccessToken(): Promise<string> {
    if (this.tokenIsFresh()) return this.creds!.access_token!;
    return this.forceRefresh();
  }

  /** Refresh regardless of current expiry (used for 401 → refresh → retry-once). */
  async forceRefresh(): Promise<string> {
    // Coalesce concurrent refreshes into one request.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const creds = this.creds;
    if (!creds?.refresh_token) {
      throw new UpstreamError('no stored refresh token; run `warden auth`', 'UPSTREAM_AUTH_REQUIRED');
    }
    let response: TokenResponse;
    try {
      response = await refreshAccessToken(
        {
          tokenEndpoint: creds.token_endpoint,
          clientId: creds.client_id,
          refreshToken: creds.refresh_token,
        },
        this.fetchFn,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.code === 'UPSTREAM_AUTH_REQUIRED') {
        throw new UpstreamError(
          'refresh token rejected; run `warden auth`',
          'UPSTREAM_AUTH_REQUIRED',
        );
      }
      throw err;
    }
    this.applyTokenResponse(response);
    return response.access_token;
  }

  applyTokenResponse(response: TokenResponse): void {
    if (!this.creds) throw new UpstreamError('no credentials loaded', 'UPSTREAM_AUTH_REQUIRED');
    this.creds = {
      ...this.creds,
      access_token: response.access_token,
      access_token_expires_at: new Date(
        this.nowMs() + (response.expires_in ?? 300) * 1000,
      ).toISOString(),
      // rotating refresh tokens: keep the new one when the server sends it
      refresh_token: response.refresh_token ?? this.creds.refresh_token,
    };
    writeCredentials(this.path, this.creds);
  }

  /**
   * Runs an upstream call with the 401 contract from SPEC §2.7:
   * fresh token → call → on auth failure refresh once and retry → then fail
   * with UPSTREAM_AUTH_REQUIRED.
   */
  async withAuth<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken();
    try {
      return await call(token);
    } catch (err) {
      if (!isAuthFailure(err)) throw err;
      const retryToken = await this.forceRefresh();
      try {
        return await call(retryToken);
      } catch (retryErr) {
        if (isAuthFailure(retryErr)) {
          throw new UpstreamError(
            'upstream rejected a freshly refreshed token; run `warden auth`',
            'UPSTREAM_AUTH_REQUIRED',
          );
        }
        throw retryErr;
      }
    }
  }
}

export function isAuthFailure(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.code === 'UPSTREAM_AUTH_REQUIRED';
  const message = err instanceof Error ? err.message : String(err);
  return /\b401\b|unauthorized/i.test(message);
}
