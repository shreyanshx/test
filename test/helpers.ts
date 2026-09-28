/**
 * Test helpers: a tiny cookie-carrying client over the worker's SELF fetch.
 *
 * The vitest-pool-workers SELF fetcher does not persist cookies between
 * requests, so signing up / logging in and then calling an authenticated
 * route would otherwise lose the "sid" session cookie. This client captures
 * Set-Cookie response headers and replays them on subsequent requests.
 */
import { SELF } from "cloudflare:test";

const BASE = "https://example.com";

/** Parse the cookie name=value pair out of a single Set-Cookie header. */
function parseSetCookie(header: string): { name: string; value: string } | null {
  const first = header.split(";", 1)[0];
  const eq = first.indexOf("=");
  if (eq === -1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return { name, value };
}

export class TestClient {
  private cookies = new Map<string, string>();

  /** Perform a JSON request, carrying any stored cookies and capturing new ones. */
  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.cookies.size > 0) {
      headers["cookie"] = [...this.cookies.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    const res = await SELF.fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Capture any Set-Cookie headers so the session persists across requests.
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const parsed = parseSetCookie(sc);
      if (!parsed) continue;
      // An empty value (e.g. from logout) clears the cookie.
      if (parsed.value === "" || /expires=thu, 01 jan 1970/i.test(sc)) {
        this.cookies.delete(parsed.name);
      } else {
        this.cookies.set(parsed.name, parsed.value);
      }
    }

    return res;
  }

  get(path: string): Promise<Response> {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown): Promise<Response> {
    return this.request("POST", path, body);
  }
  put(path: string, body?: unknown): Promise<Response> {
    return this.request("PUT", path, body);
  }
  delete(path: string): Promise<Response> {
    return this.request("DELETE", path);
  }

  /** Whether a cookie of the given name is currently stored. */
  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }
}

let counter = 0;

/** Produce a unique email so tests don't collide on the users UNIQUE index. */
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@example.com`;
}
