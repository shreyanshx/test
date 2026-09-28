# Test Paper & Assessment Platform

A full-stack web application where **professors** author test papers and
**students** take them. Professors create papers, add questions, publish them,
and review submissions; students browse published papers, submit answers, and
get an auto-graded score. It runs entirely on Cloudflare's edge: a
[Hono](https://hono.dev) API on Cloudflare Workers, a single-page frontend
served via Workers Static Assets, and a
[SQLite-backed Durable Object](https://developers.cloudflare.com/durable-objects/api/storage-api/#sql-api)
for persistence. There is **no** account-level database to create: the Durable
Object is provisioned automatically on deploy, so the site goes live from a
bare `npx wrangler deploy` with zero manual setup and no database id.

## Roles

- **Student** — sees only *published* papers, takes them, and views their own
  result. Correct answers are never sent to students.
- **Professor (`prof`)** — creates and edits papers, adds questions, publishes
  or unpublishes, and reviews all submissions for papers they authored. A
  professor can only modify papers they own.

### Gating professor sign-up

By default this is an open classroom tool: the sign-up form lets a new account
pick either role, so anyone can register as a professor. If you want to
restrict who can become a professor, set the optional **`PROF_SIGNUP_CODE`**
binding. When it is set, `POST /api/auth/signup` with `role: "prof"` must
include a matching `prof_code` field (the sign-up UI shows a "Professor signup
code" field when *Professor* is selected); students never need it.

Set it as a Worker secret for production:

```sh
npx wrangler secret put PROF_SIGNUP_CODE
```

or, for local dev, uncomment the `vars.PROF_SIGNUP_CODE` entry in
`wrangler.jsonc`. Leaving it unset keeps the open-registration behaviour.

### Login throttling

`POST /api/auth/login` is rate-limited per `(email, ip)`: after 5 failed
attempts within a 15-minute window the pair is locked out for 15 minutes and
further attempts return HTTP `429` with a `Retry-After` header (a successful
login clears the counter). This bounds online password guessing. Failed
attempts are tracked in the `login_attempts` table.

### Sessions and logout

`POST /api/auth/logout` clears the current session. Send a JSON body of
`{ "all": true }` to revoke **every** session for the account ("sign out
everywhere") — useful if a credential may be compromised. Expired sessions are
also cleaned up lazily whenever they're looked up.

## Tech stack

- **[Hono](https://hono.dev)** — API router and middleware (auth + role
  checks), mounted in `src/index.ts`.
- **Cloudflare Workers Static Assets** — serves the SPA in `public/`. Unknown
  (non-`/api`) paths fall back to `index.html`.
- **SQLite-backed Durable Object** — a single `DataStore` Durable Object
  (bound as `DATA`) owns all persistent state via `ctx.storage.sql`. It
  initializes its schema on first access, so no external database and no
  `database_id` are required. Cloudflare provisions it on deploy via the
  `migrations` entry in `wrangler.jsonc`.
- **Auth** — session-cookie auth (`sid`, HttpOnly) backed by a `sessions`
  table; passwords hashed with Web Crypto PBKDF2 (SHA-256).
- **Vitest + `@cloudflare/vitest-pool-workers`** — tests run inside the real
  `workerd` runtime against the Durable Object binding.

## Project layout

```
src/          Worker TypeScript (index.ts entry, auth.ts, db.ts, papers.ts, store.ts DO)
public/       Static SPA frontend served by the ASSETS binding
test/         Vitest specs (auth, papers, assessment) + helpers
wrangler.jsonc  Worker config (bindings, assets, Durable Object)
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

Start the dev server:

```sh
npm run dev
```

`wrangler dev` serves the Worker and the static frontend locally with the
`DATA` (Durable Object) and `ASSETS` bindings wired up. The Durable Object
creates its own schema on first access, so there is no migration step to run.
Local SQLite state lives under `.wrangler/`. Open the printed URL in a browser,
sign up as a professor or student, and try it out.

## Tests

```sh
npm test
```

This runs Vitest via `@cloudflare/vitest-pool-workers`, which executes the
specs **inside `workerd`** against the `DataStore` Durable Object binding. The
Durable Object initializes its own schema on first access, so tests exercise
the same schema as production.

The suite covers:

- **`test/auth.spec.ts`** — signup creates a user and sets the `sid` session
  cookie; duplicate email is rejected (409); wrong password fails (401);
  `/api/auth/me` returns the user with the cookie and 401 without it; an
  invalid role is rejected (400); logout invalidates the session and
  `{ all: true }` revokes every session for the account; the `PROF_SIGNUP_CODE`
  gate rejects prof signups without/with a wrong code and accepts the right one
  (students unaffected); login throttling locks out after repeated failures
  (429) and a success clears the counter.
- **`test/routing.spec.ts`** — an unknown `/api/*` path returns a JSON `404`
  (not the SPA shell with `200`), while an unknown non-API path still serves
  the SPA `index.html`.
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

There is **no manual resource creation** and **no `database_id`** to configure.
The SQLite-backed Durable Object is declared entirely in `wrangler.jsonc` and
provisioned automatically on deploy. Once authenticated, a single command takes
the site live:

1. **Authenticate wrangler with your account** (first time only):

   ```sh
   npx wrangler login
   ```

2. **Deploy:**

   ```sh
   npx wrangler deploy
   ```

That's it. The Durable Object is created on first deploy and initializes its
own schema on first access.

### Required bindings

`wrangler.jsonc` declares the two bindings the Worker needs:

| Binding  | Resource                        | Notes                                                     |
| -------- | ------------------------------- | --------------------------------------------------------- |
| `DATA`   | `DataStore` Durable Object      | SQLite-backed; provisioned automatically via `migrations` |
| `ASSETS` | Static assets from `./public`   | Serves the SPA; SPA fallback to `index.html`              |

### Cloudflare Workers Builds settings

If you connect this GitHub repo to Cloudflare for automatic builds/deploys, the
"Set up your application" screen maps to this project as follows:

- **Repository:** `shreyanshx/test`.
- **Root directory:** `test`. All app code (this folder: `src/`, `public/`,
  `wrangler.jsonc`, `package.json`) lives here, so point the build's root
  directory at `test`.
- **Build command:** set it to `npx wrangler deploy`. That single command takes
  the site live because the SQLite-backed Durable Object is provisioned
  automatically from `wrangler.jsonc` on deploy, so **no Cloudflare resource has
  to be created first and no `database_id` is required**. Note that the
  standalone `wrangler preview` command was removed in wrangler v4; local
  preview is now `wrangler dev` (i.e. `npm run dev`).
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

> **Note:** no pre-deploy setup is required. The Durable Object is provisioned
> automatically on the first deploy (whether from the CLI or via Workers
> Builds), and it creates its own schema on first access.
