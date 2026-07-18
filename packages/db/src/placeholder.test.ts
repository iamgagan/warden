import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@warden/db', () => {
  it('scaffolding is wired', () => {
    expect(PACKAGE).toBe('@warden/db');
  });
});
