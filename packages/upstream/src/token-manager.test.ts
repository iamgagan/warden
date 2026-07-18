import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenManager, isAuthFailure, writeCredentials, type StoredCredentials } from './token-manager.js';
import { UpstreamError } from './types.js';

const BASE: StoredCredentials = {
  token_endpoint: 'https://auth.example/token',
  authorization_endpoint: 'https://auth.example/authorize',
  client_id: 'client-1',
  refresh_token: 'refresh-1',
};

const tokenResponse = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'warden-tokens-'));
  path = join(dir, 'nested', 'credentials.json');
});

describe('credential store', () => {
  it('writes the file with mode 600 in a created directory', () => {
    writeCredentials(path, BASE);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ client_id: 'client-1' });
  });
});

describe('TokenManager.getAccessToken', () => {
  it('refreshes when there is no access token yet, and persists rotation', async () => {
    writeCredentials(path, BASE);
    const fetchFn = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: 'at-1', token_type: 'Bearer', expires_in: 300, refresh_token: 'refresh-2' }),
    );
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => 1_000_000 });
    expect(await tm.getAccessToken()).toBe('at-1');
    expect(fetchFn).toHaveBeenCalledOnce();
    const body = String(fetchFn.mock.calls[0]![1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-1');
    // rotated refresh token persisted to disk
    expect(JSON.parse(readFileSync(path, 'utf8')).refresh_token).toBe('refresh-2');
  });

  it('reuses a token with more than 60s of life, refreshes under 60s', async () => {
    let now = Date.parse('2026-07-17T00:00:00.000Z');
    writeCredentials(path, {
      ...BASE,
      access_token: 'at-old',
      access_token_expires_at: new Date(now + 90_000).toISOString(),
    });
    const fetchFn = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: 'at-new', token_type: 'Bearer', expires_in: 300 }),
    );
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => now });
    expect(await tm.getAccessToken()).toBe('at-old');
    expect(fetchFn).not.toHaveBeenCalled();
    now += 40_000; // 50s of life left → proactive refresh
    expect(await tm.getAccessToken()).toBe('at-new');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent refreshes into one request', async () => {
    writeCredentials(path, BASE);
    const fetchFn = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: 'at-1', token_type: 'Bearer', expires_in: 300 }),
    );
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => 0 });
    const [a, b] = await Promise.all([tm.getAccessToken(), tm.getAccessToken()]);
    expect(a).toBe('at-1');
    expect(b).toBe('at-1');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('fails UPSTREAM_AUTH_REQUIRED with no stored refresh token', async () => {
    const tm = new TokenManager({ credentialsPath: path, fetchFn: vi.fn() });
    await expect(tm.getAccessToken()).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_REQUIRED' });
  });

  it('maps a rejected refresh token to UPSTREAM_AUTH_REQUIRED', async () => {
    writeCredentials(path, BASE);
    const fetchFn = vi.fn().mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, 400));
    const tm = new TokenManager({ credentialsPath: path, fetchFn });
    await expect(tm.getAccessToken()).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_REQUIRED' });
  });
});

describe('TokenManager.withAuth (401 contract)', () => {
  const freshCreds = (now: number): StoredCredentials => ({
    ...BASE,
    access_token: 'at-0',
    access_token_expires_at: new Date(now + 600_000).toISOString(),
  });

  it('passes through a successful call without refreshing', async () => {
    const now = 1_000_000;
    writeCredentials(path, freshCreds(now));
    const fetchFn = vi.fn();
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => now });
    const result = await tm.withAuth(async (token) => `ok:${token}`);
    expect(result).toBe('ok:at-0');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('on 401: refreshes once and retries with the new token', async () => {
    const now = 1_000_000;
    writeCredentials(path, freshCreds(now));
    const fetchFn = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: 'at-1', token_type: 'Bearer', expires_in: 300 }),
    );
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => now });
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
      .mockResolvedValueOnce('recovered');
    expect(await tm.withAuth(call)).toBe('recovered');
    expect(call).toHaveBeenNthCalledWith(1, 'at-0');
    expect(call).toHaveBeenNthCalledWith(2, 'at-1');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('on 401 twice: fails UPSTREAM_AUTH_REQUIRED (retry exactly once)', async () => {
    const now = 1_000_000;
    writeCredentials(path, freshCreds(now));
    const fetchFn = vi.fn().mockResolvedValue(
      tokenResponse({ access_token: 'at-1', token_type: 'Bearer', expires_in: 300 }),
    );
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => now });
    const call = vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized'));
    await expect(tm.withAuth(call)).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_REQUIRED' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not treat non-auth errors as refreshable', async () => {
    const now = 1_000_000;
    writeCredentials(path, freshCreds(now));
    const fetchFn = vi.fn();
    const tm = new TokenManager({ credentialsPath: path, fetchFn, now: () => now });
    const call = vi.fn().mockRejectedValue(new Error('HTTP 500 boom'));
    await expect(tm.withAuth(call)).rejects.toThrow(/500/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('isAuthFailure', () => {
  it('recognizes UpstreamError codes and 401-ish messages only', () => {
    expect(isAuthFailure(new UpstreamError('x', 'UPSTREAM_AUTH_REQUIRED'))).toBe(true);
    expect(isAuthFailure(new UpstreamError('x'))).toBe(false);
    expect(isAuthFailure(new Error('got 401 from server'))).toBe(true);
    expect(isAuthFailure(new Error('Unauthorized'))).toBe(true);
    expect(isAuthFailure(new Error('HTTP 4011 weird'))).toBe(false);
    expect(isAuthFailure(new Error('boom'))).toBe(false);
  });
});
