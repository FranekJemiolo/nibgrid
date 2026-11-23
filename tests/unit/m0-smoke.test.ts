import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M0 Baseline Scaffold', () => {
  it('enforces strict TypeScript compiler flags', () => {
    const tsconfigRaw = readFileSync(resolve(process.cwd(), 'tsconfig.json'), 'utf8');
    const tsconfig = JSON.parse(tsconfigRaw) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.compilerOptions.noImplicitAny).toBe(true);
  });

  it('exposes VITE_BASE_PATH configuration in vite.config.ts', () => {
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain('VITE_BASE_PATH');
  });
});
