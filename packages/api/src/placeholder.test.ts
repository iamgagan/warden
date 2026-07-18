import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@warden/api', () => {
  it('scaffolding is wired', () => {
    expect(PACKAGE).toBe('@warden/api');
  });
});
