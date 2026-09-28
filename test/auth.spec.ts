import { describe, it, expect } from "vitest";
import { TestClient, uniqueEmail } from "./helpers";
import { TEST_PROF_CODE } from "./prof-code";

describe("auth API", () => {
  it("signup creates a user and sets a session cookie", async () => {
    const client = new TestClient();
    const email = uniqueEmail("signup");
    const res = await client.post("/api/auth/signup", {
      email,
      name: "Alice Student",
      password: "supersecret",
      role: "student",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: number; email: string; name: string; role: string };
    };
    expect(body.user.email).toBe(email);
    expect(body.user.name).toBe("Alice Student");
    expect(body.user.role).toBe("student");
    expect(typeof body.user.id).toBe("number");
    // The signup response must set the session cookie.
    expect(client.hasCookie("sid")).toBe(true);
  });

  it("rejects duplicate email registrations with 409", async () => {
    const email = uniqueEmail("dupe");
    const first = new TestClient();
    const firstRes = await first.post("/api/auth/signup", {
      email,
      name: "First",
      password: "supersecret",
      role: "student",
    });
    expect(firstRes.status).toBe(201);

    const second = new TestClient();
    const secondRes = await second.post("/api/auth/signup", {
      email,
      name: "Second",
      password: "supersecret",
      role: "student",
    });
    expect(secondRes.status).toBe(409);
  });

  it("rejects signup with a role that is not student or prof", async () => {
    const client = new TestClient();
    const res = await client.post("/api/auth/signup", {
      email: uniqueEmail("badrole"),
      name: "Bad Role",
      password: "supersecret",
      role: "admin",
    });
    expect(res.status).toBe(400);
  });

  it("login with the wrong password fails with 401", async () => {
    const email = uniqueEmail("login");
    const setup = new TestClient();
    await setup.post("/api/auth/signup", {
      email,
      name: "Login User",
      password: "correct-password",
      role: "student",
    });

    const client = new TestClient();
    const res = await client.post("/api/auth/login", {
      email,
      password: "wrong-password",
    });
    expect(res.status).toBe(401);
  });

  it("login with correct password succeeds and issues a session", async () => {
    const email = uniqueEmail("login-ok");
    const setup = new TestClient();
    await setup.post("/api/auth/signup", {
      email,
      name: "Login OK",
      password: "correct-password",
      role: "student",
    });

    const client = new TestClient();
    const res = await client.post("/api/auth/login", {
      email,
      password: "correct-password",
    });
    expect(res.status).toBe(200);
    expect(client.hasCookie("sid")).toBe(true);
  });

  it("logout invalidates the session for subsequent requests", async () => {
    const email = uniqueEmail("logout");
    const client = new TestClient();
    await client.post("/api/auth/signup", {
      email,
      name: "Logout User",
      password: "supersecret",
      role: "student",
    });

    // Authenticated before logout.
    expect((await client.get("/api/auth/me")).status).toBe(200);

    const logoutRes = await client.post("/api/auth/logout");
    expect(logoutRes.status).toBe(200);

    // The cookie was cleared and the session row deleted, so /me is now 401.
    const afterRes = await client.get("/api/auth/me");
    expect(afterRes.status).toBe(401);
  });

  it("logout with { all: true } revokes every session for the account", async () => {
    const email = uniqueEmail("revoke-all");
    // Two independent sessions for the same account (e.g. two devices).
    const deviceA = new TestClient();
    await deviceA.post("/api/auth/signup", {
      email,
      name: "Multi Device",
      password: "supersecret",
      role: "student",
    });

    const deviceB = new TestClient();
    const loginB = await deviceB.post("/api/auth/login", {
      email,
      password: "supersecret",
    });
    expect(loginB.status).toBe(200);

    // Both sessions are valid.
    expect((await deviceA.get("/api/auth/me")).status).toBe(200);
    expect((await deviceB.get("/api/auth/me")).status).toBe(200);

    // Device B signs out everywhere.
    const revoke = await deviceB.post("/api/auth/logout", { all: true });
    expect(revoke.status).toBe(200);

    // Device A's session is now revoked too.
    expect((await deviceA.get("/api/auth/me")).status).toBe(401);
  });

  it("/api/auth/me returns the user when the cookie is sent and 401 without it", async () => {
    const email = uniqueEmail("me");
    const client = new TestClient();
    await client.post("/api/auth/signup", {
      email,
      name: "Me User",
      password: "supersecret",
      role: "student",
    });

    // With the session cookie carried by the client.
    const meRes = await client.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { user: { email: string } };
    expect(body.user.email).toBe(email);

    // A fresh client (no cookie) is unauthorized.
    const anon = new TestClient();
    const anonRes = await anon.get("/api/auth/me");
    expect(anonRes.status).toBe(401);
  });
});

describe("professor signup gating (PROF_SIGNUP_CODE)", () => {
  // The test environment sets PROF_SIGNUP_CODE (vitest.config.ts), so the
  // professor self-registration gate (review finding 1) is active here.

  it("rejects prof signup with no code when the gate is set", async () => {
    const noCode = new TestClient();
    const noCodeRes = await noCode.post("/api/auth/signup", {
      email: uniqueEmail("gated-prof"),
      name: "Gated Prof",
      password: "supersecret",
      role: "prof",
    });
    expect(noCodeRes.status).toBe(403);
  });

  it("rejects prof signup with a wrong code when the gate is set", async () => {
    const wrong = new TestClient();
    const wrongRes = await wrong.post("/api/auth/signup", {
      email: uniqueEmail("gated-prof"),
      name: "Gated Prof",
      password: "supersecret",
      role: "prof",
      prof_code: "definitely-not-the-code",
    });
    expect(wrongRes.status).toBe(403);
  });

  it("allows prof signup with the correct code", async () => {
    const prof = new TestClient();
    const profRes = await prof.post("/api/auth/signup", {
      email: uniqueEmail("gated-ok"),
      name: "Allowed Prof",
      password: "supersecret",
      role: "prof",
      prof_code: TEST_PROF_CODE,
    });
    expect(profRes.status).toBe(201);
    const profBody = (await profRes.json()) as { user: { role: string } };
    expect(profBody.user.role).toBe("prof");
  });

  it("students never need the code even when the gate is set", async () => {
    const student = new TestClient();
    const studentRes = await student.post("/api/auth/signup", {
      email: uniqueEmail("gated-student"),
      name: "Student",
      password: "supersecret",
      role: "student",
    });
    expect(studentRes.status).toBe(201);
  });
});

describe("login throttling", () => {
  it("locks out after repeated failed logins and returns 429", async () => {
    const email = uniqueEmail("throttle");
    const setup = new TestClient();
    await setup.post("/api/auth/signup", {
      email,
      name: "Throttle User",
      password: "correct-password",
      role: "student",
    });

    // Five failed attempts (the configured threshold) all return 401.
    for (let i = 0; i < 5; i++) {
      const attempt = new TestClient();
      const res = await attempt.post("/api/auth/login", {
        email,
        password: "wrong-password",
      });
      expect(res.status).toBe(401);
    }

    // The sixth attempt is locked out, even with the CORRECT password.
    const locked = new TestClient();
    const lockedRes = await locked.post("/api/auth/login", {
      email,
      password: "correct-password",
    });
    expect(lockedRes.status).toBe(429);
    expect(lockedRes.headers.get("retry-after")).toBeTruthy();
  });

  it("a successful login clears the failure counter", async () => {
    const email = uniqueEmail("throttle-clear");
    const setup = new TestClient();
    await setup.post("/api/auth/signup", {
      email,
      name: "Clear User",
      password: "correct-password",
      role: "student",
    });

    // A few failures, but below the lockout threshold.
    for (let i = 0; i < 3; i++) {
      const attempt = new TestClient();
      const res = await attempt.post("/api/auth/login", {
        email,
        password: "wrong-password",
      });
      expect(res.status).toBe(401);
    }

    // A correct login succeeds and resets the counter.
    const good = new TestClient();
    const goodRes = await good.post("/api/auth/login", {
      email,
      password: "correct-password",
    });
    expect(goodRes.status).toBe(200);

    // After the reset, several more failures still don't immediately lock out.
    for (let i = 0; i < 4; i++) {
      const attempt = new TestClient();
      const res = await attempt.post("/api/auth/login", {
        email,
        password: "wrong-password",
      });
      expect(res.status).toBe(401);
    }
  });
});
