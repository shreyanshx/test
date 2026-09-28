/**
 * Test-paper & assessment platform - Worker entry point.
 *
 * API routes live under /api/*. All other requests fall through to the
 * static assets binding (the SPA frontend in ./public).
 */

import { Hono } from "hono";
import type { Bindings, Role } from "./db";
import {
  createSession,
  deleteSession,
  findUserByEmail,
  insertUser,
} from "./db";
import {
  AuthVariables,
  clearSessionCookie,
  getSessionId,
  hashPassword,
  newSessionId,
  requireAuth,
  requireRole,
  sessionExpiry,
  setSessionCookie,
  verifyPassword,
} from "./auth";
import {
  addQuestion,
  createPaper,
  deletePaper,
  findPaperById,
  findSubmission,
  gradeAnswers,
  listPapersByAuthor,
  listPublishedPapers,
  listQuestions,
  listSubmissionsForPaper,
  nextQuestionPosition,
  toPublicQuestion,
  updatePaper,
  upsertSubmission,
} from "./papers";

type Env = { Bindings: Bindings; Variables: AuthVariables };

const app = new Hono<Env>();

const VALID_ROLES: Role[] = ["student", "prof"];

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// ---- Auth API ----

const auth = new Hono<Env>();

auth.post("/signup", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, name, password, role } = body as {
    email?: unknown;
    name?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (!isValidEmail(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "Name is required" }, 400);
  }
  if (typeof password !== "string" || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  if (typeof role !== "string" || !VALID_ROLES.includes(role as Role)) {
    return c.json({ error: "Role must be 'student' or 'prof'" }, 400);
  }

  const existing = await findUserByEmail(c.env.DB, email);
  if (existing) {
    return c.json({ error: "Email is already registered" }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const user = await insertUser(c.env.DB, {
    email,
    name: name.trim(),
    role: role as Role,
    passwordHash: hash,
    passwordSalt: salt,
  });

  const sid = newSessionId();
  await createSession(c.env.DB, {
    id: sid,
    userId: user.id,
    expiresAt: sessionExpiry(),
  });
  setSessionCookie(c, sid);

  return c.json(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    },
    201
  );
});

auth.post("/login", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, password } = body as {
    email?: unknown;
    password?: unknown;
  };

  if (typeof email !== "string" || typeof password !== "string") {
    return c.json({ error: "Email and password are required" }, 400);
  }

  const user = await findUserByEmail(c.env.DB, email);
  if (!user) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const ok = await verifyPassword(
    password,
    user.password_hash,
    user.password_salt
  );
  if (!ok) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const sid = newSessionId();
  await createSession(c.env.DB, {
    id: sid,
    userId: user.id,
    expiresAt: sessionExpiry(),
  });
  setSessionCookie(c, sid);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

auth.post("/logout", async (c) => {
  const sid = getSessionId(c);
  if (sid) {
    await deleteSession(c.env.DB, sid);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => {
  return c.json({ user: c.get("user") });
});

app.route("/api/auth", auth);

// ---- Test-paper & assessment API ----

const papers = new Hono<Env>();

// All paper routes require authentication.
papers.use("*", requireAuth);

function parsePaperId(raw: string): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// List papers. Students see published papers; professors see their own.
papers.get("/", async (c) => {
  const user = c.get("user");
  const rows =
    user.role === "prof"
      ? await listPapersByAuthor(c.env.DB, user.id)
      : await listPublishedPapers(c.env.DB);

  const list = rows.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    subject: p.subject,
    author_id: p.author_id,
    published: p.published === 1,
    created_at: p.created_at,
  }));
  return c.json({ papers: list });
});

// Create a paper (professors only).
papers.post("/", requireRole("prof"), async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { title, description, subject } = body as {
    title?: unknown;
    description?: unknown;
    subject?: unknown;
  };

  if (typeof title !== "string" || title.trim().length === 0) {
    return c.json({ error: "Title is required" }, 400);
  }

  const paper = await createPaper(c.env.DB, {
    title: title.trim(),
    description:
      typeof description === "string" && description.trim().length > 0
        ? description.trim()
        : null,
    subject:
      typeof subject === "string" && subject.trim().length > 0
        ? subject.trim()
        : null,
    authorId: c.get("user").id,
  });

  return c.json(
    {
      paper: {
        id: paper.id,
        title: paper.title,
        description: paper.description,
        subject: paper.subject,
        author_id: paper.author_id,
        published: paper.published === 1,
        created_at: paper.created_at,
      },
    },
    201
  );
});

// Get a single paper with its questions.
papers.get("/:id", async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);

  const isAuthorProf = user.role === "prof" && paper.author_id === user.id;

  if (!isAuthorProf) {
    // Non-authors (students, or other profs) only see published papers.
    if (paper.published !== 1) {
      return c.json({ error: "Paper not found" }, 404);
    }
  }

  const questions = await listQuestions(c.env.DB, id);
  // Only the author professor sees correct answers.
  const publicQuestions = questions.map((q) =>
    toPublicQuestion(q, isAuthorProf)
  );

  return c.json({
    paper: {
      id: paper.id,
      title: paper.title,
      description: paper.description,
      subject: paper.subject,
      author_id: paper.author_id,
      published: paper.published === 1,
      created_at: paper.created_at,
    },
    questions: publicQuestions,
  });
});

// Update a paper (author professor only).
papers.put("/:id", requireRole("prof"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { title, description, subject, published } = body as {
    title?: unknown;
    description?: unknown;
    subject?: unknown;
    published?: unknown;
  };

  const nextTitle =
    typeof title === "string" && title.trim().length > 0
      ? title.trim()
      : paper.title;

  const nextDescription =
    description === undefined
      ? paper.description
      : typeof description === "string" && description.trim().length > 0
        ? description.trim()
        : null;

  const nextSubject =
    subject === undefined
      ? paper.subject
      : typeof subject === "string" && subject.trim().length > 0
        ? subject.trim()
        : null;

  const nextPublished =
    published === undefined
      ? paper.published
      : published === true || published === 1 || published === "true"
        ? 1
        : 0;

  const updated = await updatePaper(c.env.DB, id, {
    title: nextTitle,
    description: nextDescription,
    subject: nextSubject,
    published: nextPublished,
  });
  if (!updated) return c.json({ error: "Paper not found" }, 404);

  return c.json({
    paper: {
      id: updated.id,
      title: updated.title,
      description: updated.description,
      subject: updated.subject,
      author_id: updated.author_id,
      published: updated.published === 1,
      created_at: updated.created_at,
    },
  });
});

// Delete a paper (author professor only).
papers.delete("/:id", requireRole("prof"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await deletePaper(c.env.DB, id);
  return c.json({ ok: true });
});

// Add a question to a paper (author professor only).
papers.post("/:id/questions", requireRole("prof"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { prompt, options, correct_answer, points } = body as {
    prompt?: unknown;
    options?: unknown;
    correct_answer?: unknown;
    points?: unknown;
  };

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return c.json({ error: "Prompt is required" }, 400);
  }
  if (typeof correct_answer !== "string" || correct_answer.trim().length === 0) {
    return c.json({ error: "correct_answer is required" }, 400);
  }

  let optionsJson: string | null = null;
  if (Array.isArray(options)) {
    const cleaned = options
      .map((o) => (typeof o === "string" ? o.trim() : String(o)))
      .filter((o) => o.length > 0);
    if (cleaned.length > 0) {
      optionsJson = JSON.stringify(cleaned);
    }
  }

  let pts = 1;
  if (typeof points === "number" && Number.isFinite(points) && points > 0) {
    pts = Math.floor(points);
  }

  const position = await nextQuestionPosition(c.env.DB, id);

  const question = await addQuestion(c.env.DB, {
    paperId: id,
    position,
    prompt: prompt.trim(),
    options: optionsJson,
    correctAnswer: correct_answer.trim(),
    points: pts,
  });

  return c.json({ question: toPublicQuestion(question, true) }, 201);
});

// View submissions for a paper (author professor only).
papers.get("/:id/submissions", requireRole("prof"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const subs = await listSubmissionsForPaper(c.env.DB, id);
  return c.json({
    submissions: subs.map((s) => ({
      id: s.id,
      student_id: s.student_id,
      student_name: s.student_name,
      student_email: s.student_email,
      score: s.score,
      max_score: s.max_score,
      submitted_at: s.submitted_at,
    })),
  });
});

// Submit answers to a paper (students only).
papers.post("/:id/submit", requireRole("student"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(c.env.DB, id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.published !== 1) {
    return c.json({ error: "Cannot submit to an unpublished paper" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const rawAnswers = (body as { answers?: unknown }).answers;
  if (
    typeof rawAnswers !== "object" ||
    rawAnswers === null ||
    Array.isArray(rawAnswers)
  ) {
    return c.json({ error: "answers must be an object map" }, 400);
  }
  const answers = rawAnswers as Record<string, unknown>;

  const questions = await listQuestions(c.env.DB, id);
  if (questions.length === 0) {
    return c.json({ error: "Paper has no questions" }, 400);
  }

  const { score, maxScore } = gradeAnswers(questions, answers);

  const submission = await upsertSubmission(c.env.DB, {
    paperId: id,
    studentId: user.id,
    answers: JSON.stringify(answers),
    score,
    maxScore,
  });

  return c.json({
    result: {
      paper_id: submission.paper_id,
      score: submission.score,
      max_score: submission.max_score,
      submitted_at: submission.submitted_at,
    },
  });
});

// Get the student's own result for a paper (students only).
papers.get("/:id/result", requireRole("student"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const submission = await findSubmission(c.env.DB, id, user.id);
  if (!submission) return c.json({ error: "No submission found" }, 404);

  return c.json({
    result: {
      paper_id: submission.paper_id,
      score: submission.score,
      max_score: submission.max_score,
      submitted_at: submission.submitted_at,
      answers: JSON.parse(submission.answers),
    },
  });
});

app.route("/api/papers", papers);

// ---- Static assets / SPA fallback ----
// Any request not handled by an /api route is served from the assets binding.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
