/**
 * Authentication: password hashing (Web Crypto PBKDF2), session cookies,
 * and Hono middleware for requiring auth / roles.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type {
  Bindings,
  PublicUser,
  Role,
  Store,
  UserRow,
} from "./db";
import {
  clearLoginAttempts,
  findLoginAttempt,
  findSession,
  getStore,
  recordFailedLogin,
  toPublicUser,
} from "./db";

const SESSION_COOKIE = "sid";
const PBKDF2_ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
// Session lifetime: 7 days.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---- login throttling ----
// Per (email, ip) sliding window: after LOGIN_MAX_FAILURES failed attempts
// within LOGIN_WINDOW_MS, the pair is locked out for LOGIN_LOCKOUT_MS. This
// bounds online password guessing without needing external state.
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

// ---- hex helpers ----

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ---- password hashing (PBKDF2 SHA-256) ----

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** Returns { hash, salt } as hex strings for storage. */
export async function hashPassword(
  password: string
): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(password, salt);
  return { hash: toHex(derived), salt: toHex(salt) };
}

/** Constant-time comparison of two equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  storedHashHex: string,
  storedSaltHex: string
): Promise<boolean> {
  const salt = fromHex(storedSaltHex);
  const derived = await pbkdf2(password, salt);
  const expected = fromHex(storedHashHex);
  return timingSafeEqual(derived, expected);
}

// ---- session cookies ----

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function sessionExpiry(now: number = Date.now()): string {
  return new Date(now + SESSION_TTL_MS).toISOString();
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function getSessionId(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

// ---- middleware ----

// Variables set on the Hono context by requireAuth.
export type AuthVariables = {
  user: PublicUser;
  userRow: UserRow;
};

type Env = { Bindings: Bindings; Variables: AuthVariables };

/** Requires a valid, non-expired session. Sets c.var.user + c.var.userRow. */
export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const sid = getSessionId(c);
  if (!sid) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const found = await findSession(getStore(c.env), sid);
  if (!found) {
    clearSessionCookie(c);
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("userRow", found.user);
  c.set("user", toPublicUser(found.user));
  await next();
});

/** Best-effort client IP for throttling: CF-Connecting-IP, else a fixed key. */
export function getClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Check whether the (email, ip) pair is currently locked out from logging in.
 * Called before verifying credentials. Returns the number of seconds remaining
 * on the lockout, or null when the caller may proceed.
 */
export async function loginLockoutRemaining(
  store: Store,
  email: string,
  ip: string,
  now: number = Date.now()
): Promise<number | null> {
  const row = await findLoginAttempt(store, email, ip);
  if (!row || !row.locked_until) return null;
  const until = new Date(row.locked_until).getTime();
  if (until <= now) return null;
  return Math.ceil((until - now) / 1000);
}

/**
 * Record a failed login attempt, applying the sliding-window / lockout policy.
 * Resets the counter when the window has elapsed; sets a lockout once the
 * failure threshold is reached.
 */
export async function registerLoginFailure(
  store: Store,
  email: string,
  ip: string,
  now: number = Date.now()
): Promise<void> {
  const row = await findLoginAttempt(store, email, ip);
  const windowStartMs = row ? new Date(row.window_start).getTime() : now;
  const withinWindow = row !== null && now - windowStartMs < LOGIN_WINDOW_MS;

  const failures = withinWindow ? row!.failures + 1 : 1;
  const windowStart = withinWindow
    ? row!.window_start
    : new Date(now).toISOString();
  const lockedUntil =
    failures >= LOGIN_MAX_FAILURES
      ? new Date(now + LOGIN_LOCKOUT_MS).toISOString()
      : null;

  await recordFailedLogin(store, {
    email,
    ip,
    now: new Date(now),
    windowStart,
    failures,
    lockedUntil,
  });
}

/** Clear the failure bucket after a successful login. */
export async function registerLoginSuccess(
  store: Store,
  email: string,
  ip: string
): Promise<void> {
  await clearLoginAttempts(store, email, ip);
}

/** Requires the authenticated user to have a specific role. Use after requireAuth. */
export function requireRole(role: Role) {
  return createMiddleware<Env>(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (user.role !== role) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
}
