import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('loads the entry module', async () => {
    const module = await import('../src/index.ts');
    expect(module).toBeDefined();
  });
});
