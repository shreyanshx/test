import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  // Read the authored D1 migrations so the test setup can apply them to the
  // in-memory test database before any spec runs.
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      // A global setup file applies the migrations to the DB binding once.
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          // Wire the pool to the same wrangler.jsonc used for real deploys so
          // tests receive the DB (D1) and ASSETS bindings.
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Expose the parsed migrations to the setup file via a test-only
            // binding. `applyD1Migrations` consumes this shape.
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
