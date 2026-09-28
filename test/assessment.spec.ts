import { describe, it, expect } from "vitest";
import { TestClient, uniqueEmail } from "./helpers";

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
  });
  expect(res.status).toBe(201);
}

/**
 * Seed a published paper with four questions of known correct answers and
 * point weights. Returns the paper id and the created question ids in order.
 */
async function seedPaper(
  prof: TestClient
): Promise<{ paperId: number; questionIds: number[] }> {
  const createRes = await prof.post("/api/papers", {
    title: `Assessment ${Date.now()}`,
    subject: "Mixed",
  });
  const { paper } = (await createRes.json()) as { paper: { id: number } };

  const specs = [
    { prompt: "Q1", correct_answer: "Alpha", points: 2 },
    { prompt: "Q2", correct_answer: "Beta", points: 3 },
    { prompt: "Q3", correct_answer: "Gamma", points: 1 },
    { prompt: "Q4", correct_answer: "Delta", points: 4 },
  ];
  const questionIds: number[] = [];
  for (const spec of specs) {
    const qRes = await prof.post(`/api/papers/${paper.id}/questions`, spec);
    expect(qRes.status).toBe(201);
    const { question } = (await qRes.json()) as { question: { id: number } };
    questionIds.push(question.id);
  }

  const pubRes = await prof.put(`/api/papers/${paper.id}`, { published: true });
  expect(pubRes.status).toBe(200);

  return { paperId: paper.id, questionIds };
}

describe("assessment grading flow", () => {
  it("auto-grades a known mix of correct and incorrect answers to a specific score", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Grader Prof");
    const { paperId, questionIds } = await seedPaper(prof);
    const [q1, q2, q3, q4] = questionIds;

    const student = new TestClient();
    await signUp(student, "student", "Test Taker");

    // Correct: Q1 (2 pts) and Q2 (3 pts). Incorrect: Q3 and Q4.
    // Also verifies case-insensitivity + trimming on Q2.
    const submitRes = await student.post(`/api/papers/${paperId}/submit`, {
      answers: {
        [q1]: "Alpha",
        [q2]: "  beta  ",
        [q3]: "wrong",
        [q4]: "also wrong",
      },
    });
    expect(submitRes.status).toBe(200);
    const { result } = (await submitRes.json()) as {
      result: { score: number; max_score: number };
    };

    // Max = 2 + 3 + 1 + 4 = 10; earned = 2 + 3 = 5. Exact numbers so the
    // test fails if grading logic is reverted or broken.
    expect(result.max_score).toBe(10);
    expect(result.score).toBe(5);
  });

  it("re-submitting updates the score in place without duplicating rows", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Resubmit Prof");
    const { paperId, questionIds } = await seedPaper(prof);
    const [q1, q2, q3, q4] = questionIds;

    const student = new TestClient();
    await signUp(student, "student", "Resubmit Student");

    // First attempt: only Q1 correct -> score 2 / 10.
    const first = await student.post(`/api/papers/${paperId}/submit`, {
      answers: { [q1]: "Alpha" },
    });
    const firstBody = (await first.json()) as { result: { score: number } };
    expect(firstBody.result.score).toBe(2);

    // Second attempt: all correct -> score 10 / 10.
    const second = await student.post(`/api/papers/${paperId}/submit`, {
      answers: { [q1]: "Alpha", [q2]: "Beta", [q3]: "Gamma", [q4]: "Delta" },
    });
    const secondBody = (await second.json()) as {
      result: { score: number; max_score: number };
    };
    expect(secondBody.result.score).toBe(10);
    expect(secondBody.result.max_score).toBe(10);

    // The student's stored result reflects the latest attempt.
    const resultRes = await student.get(`/api/papers/${paperId}/result`);
    const resultBody = (await resultRes.json()) as {
      result: { score: number };
    };
    expect(resultBody.result.score).toBe(10);

    // Exactly one submission row exists for this student/paper: the prof's
    // submissions endpoint should list a single entry.
    const subsRes = await prof.get(`/api/papers/${paperId}/submissions`);
    const subsBody = (await subsRes.json()) as {
      submissions: { student_id: number; score: number }[];
    };
    expect(subsBody.submissions.length).toBe(1);
    expect(subsBody.submissions[0].score).toBe(10);
  });

  it("rejects submitting to an unpublished paper", async () => {
    const prof = new TestClient();
    await signUp(prof, "prof", "Draft Prof");

    const createRes = await prof.post("/api/papers", { title: "Draft Quiz" });
    const { paper } = (await createRes.json()) as { paper: { id: number } };
    const qRes = await prof.post(`/api/papers/${paper.id}/questions`, {
      prompt: "Q1",
      correct_answer: "Alpha",
      points: 1,
    });
    const { question } = (await qRes.json()) as { question: { id: number } };

    const student = new TestClient();
    await signUp(student, "student", "Eager Student");

    const submitRes = await student.post(`/api/papers/${paper.id}/submit`, {
      answers: { [question.id]: "Alpha" },
    });
    expect(submitRes.status).toBe(403);
  });
});
