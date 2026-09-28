import { describe, it, expect } from "vitest";
import { TestClient, uniqueEmail } from "./helpers";

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
      role: "prof",
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
      role: "prof",
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
