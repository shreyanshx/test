# Test Paper & Assessment Platform

A full-stack web application where **professors** author test papers and
**students** take them. Professors create papers, add questions, publish them,
and review submissions; students browse published papers, submit answers, and
get an auto-graded score. It runs entirely on Cloudflare's edge: a
[Hono](https://hono.dev) API on Cloudflare Workers, a single-page frontend
served via Workers Static Assets, and [D1](https://developers.cloudflare.com/d1/)
(SQLite) for persistence.

## Roles

- **Student** — sees only *published* papers, takes them, and views their own
  result. Correct answers are never sent to students.
- **Professor (`prof`)** — creates and edits papers, adds questions, publishes
  or unpublishes, and reviews all submissions for papers they authored. A
  professor can only modify papers they own.

## Tech stack

- **[Hono](https://hono.dev)** — API router and middleware (auth + role
  checks), mounted in `src/index.ts`.
- **Cloudflare Workers Static Assets** — serves the SPA in `public/`. Unknown
  (non-`/api`) paths fall back to `index.html`.
- **Cloudflare D1** — SQLite database bound as `DB`. Schema lives in
  `migrations/`.
- **Auth** — session-cookie auth (`sid`, HttpOnly) backed by a `sessions`
  table; passwords hashed with Web Crypto PBKDF2 (SHA-256).
- **Vitest + `@cloudflare/vitest-pool-workers`** — tests run inside the real
  `workerd` runtime against a local D1 binding.

## Project layout

```
src/          Worker TypeScript (index.ts entry, auth.ts, db.ts, papers.ts)
public/       Static SPA frontend served by the ASSETS binding
migrations/   D1 SQL migrations (0001_init.sql, 0002_papers.sql)
test/         Vitest specs (auth, papers, assessment) + helpers
wrangler.jsonc  Worker config (bindings, assets, D1)
```

## Prerequisites

- **Node.js 18+** (developed on Node 22).
- **npm** (ships with Node).
- A **Cloudflare account** — only needed for a real deploy, not for local dev
  or tests. `wrangler` is installed as a dev dependency, so use it via `npx`.

## Install

```sh
npm install
```

## Local development

1. Apply the migrations to your **local** D1 database:

   ```sh
   npm run db:migrate:local
   ```

   (This runs `wrangler d1 migrations apply testpaper_db --local`, creating the
   local SQLite state under `.wrangler/`.)

2. Start the dev server:

   ```sh
   npm run dev
   ```

   `wrangler dev` serves the Worker and the static frontend locally with the
   `DB` and `ASSETS` bindings wired up. Open the printed URL in a browser,
   sign up as a professor or student, and try it out.

## Tests

```sh
npm test
```

This runs Vitest via `@cloudflare/vitest-pool-workers`, which executes the
specs **inside `workerd`** with a real local D1 binding. `vitest.config.ts`
reads the SQL in `migrations/` and applies it to the test database before the
specs run (see `test/apply-migrations.ts`), so tests exercise the same schema
as production.

The suite covers:

- **`test/auth.spec.ts`** — signup creates a user and sets the `sid` session
  cookie; duplicate email is rejected (409); wrong password fails (401);
  `/api/auth/me` returns the user with the cookie and 401 without it; an
  invalid role is rejected (400).
- **`test/papers.spec.ts`** — a professor creates a paper, adds questions, and
  publishes; a student lists only published papers; `GET /api/papers/:id` as a
  student omits `correct_answer`; a student hitting a prof-only route gets 403;
  a professor cannot modify another professor's paper (403).
- **`test/assessment.spec.ts`** — seeds a published paper with known correct
  answers and point weights, submits a known mix of correct/incorrect answers,
  and asserts an exact `score`/`max_score` (5 / 10) so the test fails if
  grading is broken; re-submitting updates in place (still exactly one
  submission row); submitting to an unpublished paper is rejected (403).

The session cookie is not persisted automatically by the pool's `SELF` fetch,
so `test/helpers.ts` provides a small cookie-carrying `TestClient` that
captures `Set-Cookie` and replays it on later requests.

## Configuration validation

Validate that the Worker bundles and `wrangler.jsonc` is valid without
deploying (no Cloudflare account required):

```sh
npx wrangler deploy --dry-run --outdir=dist
```

## Deploy to Cloudflare

A real deploy needs your Cloudflare account and a real D1 database id. Run
these steps once to set up, then deploy:

1. **Authenticate wrangler with your account:**

   ```sh
   npx wrangler login
   ```

2. **Create the D1 database** (the name must match `wrangler.jsonc`):

   ```sh
   npx wrangler d1 create testpaper_db
   ```

   This prints a `database_id`. **Copy it and paste it into `wrangler.jsonc`**,
   replacing the placeholder `database_id` under the `d1_databases` entry:

   ```jsonc
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "testpaper_db",
       "database_id": "<paste-the-id-from-the-command-here>",
       "migrations_dir": "migrations"
     }
   ]
   ```

3. **Apply the migrations to the remote (production) database:**

   ```sh
   npm run db:migrate:remote
   ```

   (Runs `wrangler d1 migrations apply testpaper_db --remote`.)

4. **Deploy:**

   ```sh
   npx wrangler deploy
   ```

### Required bindings

`wrangler.jsonc` declares the two bindings the Worker needs:

| Binding  | Resource                    | Notes                                        |
| -------- | --------------------------- | -------------------------------------------- |
| `DB`     | D1 database `testpaper_db`  | Set `database_id` after `wrangler d1 create` |
| `ASSETS` | Static assets from `./public` | Serves the SPA; SPA fallback to `index.html` |

### Cloudflare Workers Builds settings

If you connect this GitHub repo to Cloudflare for automatic builds/deploys, the
"Set up your application" screen maps to this project as follows:

- **Repository:** `shreyanshx/test`.
- **Root directory:** `test`. All app code (this folder — `src/`, `public/`,
  `migrations/`, `wrangler.jsonc`, `package.json`) lives here, so point the
  build's root directory at `test`.
- **Build command (optional):** the authoritative deploy command for this
  project is `npx wrangler deploy`. You can leave the Build command field blank
  (or set a no-op) and let the platform deploy from `wrangler.jsonc`, or set it
  explicitly to `npx wrangler deploy`. For previews the analogous command is
  `npx wrangler preview`. Note that current wrangler versions have moved
  preview onto `wrangler versions upload` (and `wrangler dev` for local
  preview), but `npx wrangler deploy` remains the authoritative deploy command
  your settings reference.
- **Enable Preview builds:** when on, Cloudflare builds a preview deployment for
  pull requests / non-production branches so you can review changes on a
  separate URL before they reach production. Leave off if you only want
  production deploys.
- **Protect with Cloudflare Access:** when on, Cloudflare Access sits **in front
  of the deployed Worker URL** and requires viewers to authenticate (against
  your configured identity provider / access policy) before any request reaches
  the app. This is an extra network-level gate on top of the app's own
  session-cookie login — useful for locking a preview or the whole app to your
  organization.

> **Note:** the D1 `database_id` must be filled in and the remote migrations
> applied (steps 2–3) before the first successful production deploy, regardless
> of whether you deploy from the CLI or via Workers Builds.
