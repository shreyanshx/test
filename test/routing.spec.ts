import { describe, it, expect } from "vitest";
import { TestClient } from "./helpers";

describe("API routing fallback", () => {
  it("an unknown /api/* path returns a JSON 404, not the SPA shell", async () => {
    const client = new TestClient();
    // A mistyped API path that matches no route. Previously this fell through
    // to the SPA fallback and returned index.html with status 200 (review
    // finding 2). It must now be a machine-readable 404.
    const res = await client.get("/api/paper/1");
    expect(res.status).toBe(404);

    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  it("an unknown /api/* path with a non-GET method also returns JSON 404", async () => {
    const client = new TestClient();
    const res = await client.delete("/api/auth/login");
    expect(res.status).toBe(404);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });

  it("a non-API unknown path still serves the SPA (index.html)", async () => {
    const client = new TestClient();
    const res = await client.get("/some/spa/route");
    // The assets binding serves the SPA shell for unknown non-API paths.
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
  });
});
