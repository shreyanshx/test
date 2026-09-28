/**
 * Bindings and typed data helpers for the auth layer.
 *
 * Persistence lives in a SQLite-backed Durable Object (see src/store.ts). The
 * helpers below keep their former external shapes but delegate every query to
 * the DO singleton, so callers see the same row types they saw with D1.
 */

import type { DataStore } from "./store";

/** The Durable Object stub for the data store singleton. */
export type Store = DurableObjectStub<DataStore>;

export type Bindings = {
  /** SQLite-backed Durable Object namespace holding all app state. */
  DATA: DurableObjectNamespace<DataStore>;
  ASSETS: Fetcher;
  /**
   * Optional secret gating professor self-registration. When set (via
   * `wrangler secret put PROF_SIGNUP_CODE` or a `[vars]` entry), a signup that
   * asks for the `prof` role must supply a matching `prof_code`. When unset the
   * signup form behaves as an open classroom tool (anyone may pick `prof`).
   */
  PROF_SIGNUP_CODE?: string;
};

/** Resolve the singleton data-store stub for this environment. */
export function getStore(env: Bindings): Store {
  return env.DATA.get(env.DATA.idFromName("global"));
}

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
  store: Store,
  email: string
): Promise<UserRow | null> {
  return store.findUserByEmail(email);
}

export async function findUserById(
  store: Store,
  id: number
): Promise<UserRow | null> {
  return store.findUserById(id);
}

export async function insertUser(
  store: Store,
  params: {
    email: string;
    name: string;
    role: Role;
    passwordHash: string;
    passwordSalt: string;
  }
): Promise<UserRow> {
  return store.insertUser(params);
}

export async function createSession(
  store: Store,
  params: { id: string; userId: number; expiresAt: string }
): Promise<void> {
  await store.createSession(params);
}

/** Returns the session joined with its user, only if not expired. */
export async function findSession(
  store: Store,
  sessionId: string
): Promise<{ session: SessionRow; user: UserRow } | null> {
  return store.findSession(sessionId);
}

export async function deleteSession(
  store: Store,
  sessionId: string
): Promise<void> {
  await store.deleteSession(sessionId);
}

/**
 * Revoke every session belonging to a user ("sign out everywhere"). Used by
 * logout when the caller asks for a global revoke, and available for account
 * compromise flows. Returns the number of sessions removed.
 */
export async function deleteSessionsForUser(
  store: Store,
  userId: number
): Promise<number> {
  return store.deleteSessionsForUser(userId);
}

/** Delete every session whose expiry is at or before `now` (housekeeping). */
export async function deleteExpiredSessions(
  store: Store,
  now: Date = new Date()
): Promise<number> {
  return store.deleteExpiredSessions(now.toISOString());
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
  store: Store,
  email: string,
  ip: string
): Promise<LoginAttemptRow | null> {
  return store.findLoginAttempt(email, ip);
}

/**
 * Record a failed login for (email, ip). Increments the failure counter within
 * the current window (resetting it if the window has elapsed) and sets
 * `locked_until` once the threshold is reached. Returns the updated row.
 */
export async function recordFailedLogin(
  store: Store,
  params: {
    email: string;
    ip: string;
    now: Date;
    windowStart: string;
    failures: number;
    lockedUntil: string | null;
  }
): Promise<void> {
  await store.recordFailedLogin({
    email: params.email,
    ip: params.ip,
    windowStart: params.windowStart,
    failures: params.failures,
    lockedUntil: params.lockedUntil,
  });
}

/** Clear the failure bucket for (email, ip) after a successful login. */
export async function clearLoginAttempts(
  store: Store,
  email: string,
  ip: string
): Promise<void> {
  await store.clearLoginAttempts(email, ip);
}
