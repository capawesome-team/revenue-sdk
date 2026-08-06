// The tsconfig deliberately excludes Node type definitions so `src/` cannot use Node globals;
// live tests read environment variables through this narrow typing instead.
export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}
