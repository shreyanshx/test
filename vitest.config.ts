import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  return {
    test: {
      poolOptions: {
        workers: {
          // Wire the pool to the same wrangler.jsonc used for real deploys so
          // tests receive the DATA (Durable Object) and ASSETS bindings.
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // PROF_SIGNUP_CODE exercises the professor self-registration gate
            // (review finding 1): with it set, prof signups must supply the
            // matching `prof_code`. Tests import this value from
            // ./test/prof-code.ts.
            bindings: {
              PROF_SIGNUP_CODE: "test-prof-code",
            },
          },
        },
      },
    },
  };
});
