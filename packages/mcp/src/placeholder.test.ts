import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@warden/mcp', () => {
  it('scaffolding is wired', () => {
    expect(PACKAGE).toBe('@warden/mcp');
  });
});
