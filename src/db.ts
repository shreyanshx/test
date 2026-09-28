/**
 * D1 bindings and typed query helpers used by the auth layer.
 */

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
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
