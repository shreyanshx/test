import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  // Augment the test environment with our worker bindings plus the
  // test-only migrations binding wired up in vitest.config.ts.
  interface ProvidedEnv {
    DB: D1Database;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: D1Migration[];
    // Configured in vitest.config.ts to exercise the professor signup gate.
    PROF_SIGNUP_CODE?: string;
  }
}
