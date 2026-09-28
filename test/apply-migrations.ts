/**
 * Vitest setup file: applies the authored D1 migrations to the test database
 * before any spec runs. The parsed migrations are provided to the worker via
 * the TEST_MIGRATIONS binding configured in vitest.config.ts.
 */
import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before the specs execute.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
