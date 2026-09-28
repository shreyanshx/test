/**
 * D1 bindings and typed query helpers used by the auth layer.
 */

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Optional secret gating professor self-registration. When set (via
   * `wrangler secret put PROF_SIGNUP_CODE` or a `[vars]` entry), a signup that
   * asks for the `prof` role must supply a matching `prof_code`. When unset the
   * signup form behaves as an open classroom tool (anyone may pick `prof`).
   */
  PROF_SIGNUP_CODE?: string;
};

export type Role = "student" | "prof";

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  password_salt: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
  created_at: string;
}

/** Public-facing user shape (never expose password fields). */
export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function findUserByEmail(
  db: D1Database,
  email: string
): Promise<UserRow | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  return row ?? null;
}

export async function findUserById(
  db: D1Database,
  id: number
): Promise<UserRow | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
  return row ?? null;
}

export async function insertUser(
  db: D1Database,
  params: {
    email: string;
    name: string;
    role: Role;
    passwordHash: string;
    passwordSalt: string;
  }
): Promise<UserRow> {
  const row = await db
    .prepare(
      `INSERT INTO users (email, name, role, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.email,
      params.name,
      params.role,
      params.passwordHash,
      params.passwordSalt
    )
    .first<UserRow>();

  if (!row) {
    throw new Error("Failed to insert user");
  }
  return row;
}

export async function createSession(
  db: D1Database,
  params: { id: string; userId: number; expiresAt: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
    )
    .bind(params.id, params.userId, params.expiresAt)
    .run();
}

/** Returns the session joined with its user, only if not expired. */
export async function findSession(
  db: D1Database,
  sessionId: string
): Promise<{ session: SessionRow; user: UserRow } | null> {
  const session = await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<SessionRow>();

  if (!session) return null;

  // Expired sessions are treated as invalid and cleaned up.
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await deleteSession(db, sessionId);
    return null;
  }

  const user = await findUserById(db, session.user_id);
  if (!user) return null;

  return { session, user };
}

export async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

/**
 * Revoke every session belonging to a user ("sign out everywhere"). Used by
 * logout when the caller asks for a global revoke, and available for account
 * compromise flows. Returns the number of sessions removed.
 */
export async function deleteSessionsForUser(
  db: D1Database,
  userId: number
): Promise<number> {
  const res = await db
    .prepare("DELETE FROM sessions WHERE user_id = ?")
    .bind(userId)
    .run();
  return res.meta.changes ?? 0;
}

/** Delete every session whose expiry is at or before `now` (housekeeping). */
export async function deleteExpiredSessions(
  db: D1Database,
  now: Date = new Date()
): Promise<number> {
  const res = await db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
  return res.meta.changes ?? 0;
}

// ---- login throttling ----

export interface LoginAttemptRow {
  id: number;
  email: string;
  ip: string;
  failures: number;
  window_start: string;
  locked_until: string | null;
}

export async function findLoginAttempt(
  db: D1Database,
  email: string,
  ip: string
): Promise<LoginAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM login_attempts WHERE email = ? AND ip = ?")
    .bind(email, ip)
    .first<LoginAttemptRow>();
  return row ?? null;
}

/**
 * Record a failed login for (email, ip). Increments the failure counter within
 * the current window (resetting it if the window has elapsed) and sets
 * `locked_until` once the threshold is reached. Returns the updated row.
 */
export async function recordFailedLogin(
  db: D1Database,
  params: {
    email: string;
    ip: string;
    now: Date;
    windowStart: string;
    failures: number;
    lockedUntil: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts (email, ip, failures, window_start, locked_until)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email, ip)
       DO UPDATE SET failures = excluded.failures,
                     window_start = excluded.window_start,
                     locked_until = excluded.locked_until`
    )
    .bind(
      params.email,
      params.ip,
      params.failures,
      params.windowStart,
      params.lockedUntil
    )
    .run();
}

/** Clear the failure bucket for (email, ip) after a successful login. */
export async function clearLoginAttempts(
  db: D1Database,
  email: string,
  ip: string
): Promise<void> {
  await db
    .prepare("DELETE FROM login_attempts WHERE email = ? AND ip = ?")
    .bind(email, ip)
    .run();
}
