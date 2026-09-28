import { describe, it, expect } from "vitest";
import { TestClient, uniqueEmail } from "./helpers";
import { TEST_PROF_CODE } from "./prof-code";

async function signUp(
  client: TestClient,
  role: "student" | "prof",
  name: string
): Promise<void> {
  const res = await client.post("/api/auth/signup", {
    email: uniqueEmail(role),
    name,
    password: "supersecret",
    role,
    // The test env sets PROF_SIGNUP_CODE, so prof signups must supply it.
    ...(role === "prof" ? { prof_code: TEST_PROF_CODE } : {}),
  });
  expect(res.status).toBe(201);
}

describe("papers API and role permissions", () => {
  it("a prof can create a paper, add questions, and publish it", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Professor Plum");

    const createRes = await prof.post("/api/papers", {
      title: "Algebra Basics",
      description: "A short quiz",
      subject: "Math",
    });
    expect(createRes.status).toBe(201);
    const { paper } = (await createRes.json()) as {
      paper: { id: number; published: boolean };
    };
    expect(paper.published).toBe(false);

    const qRes = await prof.post(`/api/papers/${paper.id}/questions`, {
      prompt: "2 + 2 = ?",
      correct_answer: "4",
      points: 2,
    });
    expect(qRes.status).toBe(201);

    const pubRes = await prof.put(`/api/papers/${paper.id}`, {
      published: true,
    });
    expect(pubRes.status).toBe(200);
    const pub = (await pubRes.json()) as { paper: { published: boolean } };
    expect(pub.paper.published).toBe(true);
  });

  it("a student listing papers sees only published papers", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Prof Draft");

    // A draft (unpublished) paper.
    await prof.post("/api/papers", { title: "Draft Only" });

    // A published paper with a unique title we can search for.
    const publishedTitle = `Published ${Date.now()}`;
    const createRes = await prof.post("/api/papers", { title: publishedTitle });
    const { paper } = (await createRes.json()) as { paper: { id: number } };
    await prof.put(`/api/papers/${paper.id}`, { published: true });

    const student = new TestClient();
    await signUp(student, "student", "Student Sam");

    const listRes = await student.get("/api/papers");
    expect(listRes.status).toBe(200);
    const { papers } = (await listRes.json()) as {
      papers: { title: string; published: boolean }[];
    };
    // Every paper the student can see must be published.
    expect(papers.every((p) => p.published === true)).toBe(true);
    expect(papers.some((p) => p.title === publishedTitle)).toBe(true);
    expect(papers.some((p) => p.title === "Draft Only")).toBe(false);
  });

  it("GET /api/papers/:id as a student omits correct_answer", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Prof Answers");

    const createRes = await prof.post("/api/papers", { title: "Hidden Answers" });
    const { paper } = (await createRes.json()) as { paper: { id: number } };
    await prof.post(`/api/papers/${paper.id}/questions`, {
      prompt: "Capital of France?",
      correct_answer: "Paris",
      points: 1,
    });
    await prof.put(`/api/papers/${paper.id}`, { published: true });

    // The author prof sees the correct answer.
    const profDetail = await prof.get(`/api/papers/${paper.id}`);
    const profBody = (await profDetail.json()) as {
      questions: { correct_answer?: string }[];
    };
    expect(profBody.questions[0].correct_answer).toBe("Paris");

    // The student must NOT receive the correct answer.
    const student = new TestClient();
    await signUp(student, "student", "Student Sue");
    const studentDetail = await student.get(`/api/papers/${paper.id}`);
    expect(studentDetail.status).toBe(200);
    const studentBody = (await studentDetail.json()) as {
      questions: { correct_answer?: string }[];
    };
    expect(studentBody.questions[0].correct_answer).toBeUndefined();
  });

  it("a student cannot hit prof-only routes (403)", async () => {
    const student = new TestClient();
    await signUp(student, "student", "Student Sky");

    const res = await student.post("/api/papers", { title: "Nope" });
    expect(res.status).toBe(403);
  });

  it("a prof cannot modify another prof's paper (403)", async () => {
    const owner = new TestClient();
    await signUp(owner, "prof", "Owner Prof");
    const createRes = await owner.post("/api/papers", { title: "Owned Paper" });
    const { paper } = (await createRes.json()) as { paper: { id: number } };

    const other = new TestClient();
    await signUp(other, "prof", "Other Prof");

    const updateRes = await other.put(`/api/papers/${paper.id}`, {
      title: "Hijacked",
    });
    expect(updateRes.status).toBe(403);

    const questionRes = await other.post(`/api/papers/${paper.id}/questions`, {
      prompt: "Sneaky",
      correct_answer: "x",
    });
    expect(questionRes.status).toBe(403);
  });
});
