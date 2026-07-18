import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@warden/cli', () => {
  it('scaffolding is wired', () => {
    expect(PACKAGE).toBe('@warden/cli');
  });
});
