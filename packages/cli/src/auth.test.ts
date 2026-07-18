import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCredentials } from '@warden/upstream';
import { formatAuthStatus } from './auth.js';

describe('formatAuthStatus', () => {
  it('reports missing credentials', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'warden-cli-')), 'credentials.json');
    expect(formatAuthStatus(path)).toMatch(/not authenticated/);
  });

  it('reports refresh token presence and access token life', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'warden-cli-')), 'credentials.json');
    const now = Date.parse('2026-07-17T00:00:00.000Z');
    writeCredentials(path, {
      token_endpoint: 'https://auth.example/token',
      authorization_endpoint: 'https://auth.example/authorize',
      client_id: 'client-1',
      refresh_token: 'r',
      access_token: 'a',
      access_token_expires_at: new Date(now + 120_000).toISOString(),
    });
    const status = formatAuthStatus(path, now);
    expect(status).toMatch(/refresh token: {2}present/);
    expect(status).toMatch(/expires in 120s/);
  });
});
