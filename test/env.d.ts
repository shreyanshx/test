import type { DataStore } from "../src/store";

declare module "cloudflare:test" {
  // Augment the test environment with our worker bindings. All persistent
  // state lives in the SQLite-backed Durable Object (bound as DATA in
  // wrangler.jsonc); vitest-pool-workers exposes it here through the same
  // wrangler.jsonc the pool is wired to.
  interface ProvidedEnv {
    DATA: DurableObjectNamespace<DataStore>;
    ASSETS: Fetcher;
    // Configured in vitest.config.ts to exercise the professor signup gate.
    PROF_SIGNUP_CODE?: string;
  }
}
