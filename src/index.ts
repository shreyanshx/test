/**
 * Test-paper & assessment platform - Worker entry point.
 *
 * API routes live under /api/*. All other requests fall through to the
 * static assets binding (the SPA frontend in ./public).
 */

import { Hono } from "hono";
import type { Bindings, Role } from "./db";
import {
  createSession,
  deleteSession,
  findUserByEmail,
  insertUser,
} from "./db";
import {
  AuthVariables,
  clearSessionCookie,
  getSessionId,
  hashPassword,
  newSessionId,
  requireAuth,
  sessionExpiry,
  setSessionCookie,
  verifyPassword,
} from "./auth";

type Env = { Bindings: Bindings; Variables: AuthVariables };

const app = new Hono<Env>();

const VALID_ROLES: Role[] = ["student", "prof"];

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// ---- Auth API ----

const auth = new Hono<Env>();

auth.post("/signup", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, name, password, role } = body as {
    email?: unknown;
    name?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (!isValidEmail(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "Name is required" }, 400);
  }
  if (typeof password !== "string" || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  if (typeof role !== "string" || !VALID_ROLES.includes(role as Role)) {
    return c.json({ error: "Role must be 'student' or 'prof'" }, 400);
  }

  const existing = await findUserByEmail(c.env.DB, email);
  if (existing) {
    return c.json({ error: "Email is already registered" }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const user = await insertUser(c.env.DB, {
    email,
    name: name.trim(),
    role: role as Role,
    passwordHash: hash,
    passwordSalt: salt,
  });

  const sid = newSessionId();
  await createSession(c.env.DB, {
    id: sid,
    userId: user.id,
    expiresAt: sessionExpiry(),
  });
  setSessionCookie(c, sid);

  return c.json(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    },
    201
  );
});

auth.post("/login", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, password } = body as {
    email?: unknown;
    password?: unknown;
  };

  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const user = await findUserByEmail(c.env.DB, email);
  if (!user) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const ok = await verifyPassword(
    password,
    user.password_hash,
    user.password_salt
  );
  if (!ok) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const sid = newSessionId();
  await createSession(c.env.DB, {
    id: sid,
    userId: user.id,
    expiresAt: sessionExpiry(),
  });
  setSessionCookie(c, sid);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

auth.post("/logout", async (c) => {
  const sid = getSessionId(c);
  if (sid) {
    await deleteSession(c.env.DB, sid);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => {
  return c.json({ user: c.get("user") });
});

app.route("/api/auth", auth);

// ---- Static assets / SPA fallback ----
// Any request not handled by an /api route is served from the assets binding.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
