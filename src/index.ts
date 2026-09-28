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
  deleteSessionsForUser,
  findSession,
  findUserByEmail,
  getStore,
  insertUser,
} from "./db";
import {
  AuthVariables,
  clearSessionCookie,
  getClientIp,
  getSessionId,
  hashPassword,
  loginLockoutRemaining,
  newSessionId,
  registerLoginFailure,
  registerLoginSuccess,
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

  const { email, name, password, role, prof_code } = body as {
    email?: unknown;
    name?: unknown;
    password?: unknown;
    role?: unknown;
    prof_code?: unknown;
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

  // Professor self-registration gate (review finding 1). Without this, anyone
  // could pick role "prof" and gain full authoring/grading powers. When the
  // PROF_SIGNUP_CODE binding is configured, registering as a professor requires
  // the caller to supply the matching `prof_code`. When it is unset the tool
  // behaves as an open classroom app (documented in the README), so this stays
  // opt-in and does not break local dev where no secret is set.
  if (role === "prof") {
    const expectedCode = c.env.PROF_SIGNUP_CODE;
    if (typeof expectedCode === "string" && expectedCode.length > 0) {
      if (typeof prof_code !== "string" || prof_code !== expectedCode) {
        return c.json(
          { error: "A valid professor signup code is required" },
          403
        );
      }
    }
  }

  const existing = await findUserByEmail(getStore(c.env), email);
  if (existing) {
    return c.json({ error: "Email is already registered" }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const user = await insertUser(getStore(c.env), {
    email,
    name: name.trim(),
    role: role as Role,
    passwordHash: hash,
    passwordSalt: salt,
  });

  const sid = newSessionId();
  await createSession(getStore(c.env), {
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

  // Login throttling (review finding 3): a per (email, ip) sliding-window
  // lockout bounds online password guessing. Keyed on the normalized email so
  // an attacker can't bypass it by varying letter case.
  const throttleKey = email.trim().toLowerCase();
  const ip = getClientIp(c);
  const lockedFor = await loginLockoutRemaining(getStore(c.env), throttleKey, ip);
  if (lockedFor !== null) {
    return c.json(
      { error: "Too many failed attempts. Try again later." },
      429,
      { "Retry-After": String(lockedFor) }
    );
  }

  const user = await findUserByEmail(getStore(c.env), email);
  if (!user) {
    await registerLoginFailure(getStore(c.env), throttleKey, ip);
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const ok = await verifyPassword(
    password,
    user.password_hash,
    user.password_salt
  );
  if (!ok) {
    await registerLoginFailure(getStore(c.env), throttleKey, ip);
    return c.json({ error: "Invalid email or password" }, 401);
  }

  // Successful login clears the failure bucket for this (email, ip).
  await registerLoginSuccess(getStore(c.env), throttleKey, ip);

  const sid = newSessionId();
  await createSession(getStore(c.env), {
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
  // Optional { all: true } revokes every session for the account
  // ("sign out everywhere"), addressing review finding 4. Parsing the body is
  // best-effort so a plain logout with no body still works.
  let revokeAll = false;
  try {
    const body = (await c.req.json()) as { all?: unknown };
    revokeAll = body?.all === true;
  } catch {
    revokeAll = false;
  }

  if (sid) {
    if (revokeAll) {
      // Resolve the session to its user, then drop every session they own.
      const found = await findSession(getStore(c.env), sid);
      if (found) {
        await deleteSessionsForUser(getStore(c.env), found.user.id);
      } else {
        await deleteSession(getStore(c.env), sid);
      }
    } else {
      await deleteSession(getStore(c.env), sid);
    }
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
      ? await listPapersByAuthor(getStore(c.env), user.id)
      : await listPublishedPapers(getStore(c.env));

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

  const paper = await createPaper(getStore(c.env), {
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
  const paper = await findPaperById(getStore(c.env), id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);

  const isAuthorProf = user.role === "prof" && paper.author_id === user.id;

  if (!isAuthorProf) {
    // Non-authors (students, or other profs) only see published papers.
    if (paper.published !== 1) {
      return c.json({ error: "Paper not found" }, 404);
    }
  }

  const questions = await listQuestions(getStore(c.env), id);
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
  const paper = await findPaperById(getStore(c.env), id);
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

  const updated = await updatePaper(getStore(c.env), id, {
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
  const paper = await findPaperById(getStore(c.env), id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await deletePaper(getStore(c.env), id);
  return c.json({ ok: true });
});

// Add a question to a paper (author professor only).
papers.post("/:id/questions", requireRole("prof"), async (c) => {
  const id = parsePaperId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid paper id" }, 400);

  const user = c.get("user");
  const paper = await findPaperById(getStore(c.env), id);
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

  const position = await nextQuestionPosition(getStore(c.env), id);

  const question = await addQuestion(getStore(c.env), {
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
  const paper = await findPaperById(getStore(c.env), id);
  if (!paper) return c.json({ error: "Paper not found" }, 404);
  if (paper.author_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const subs = await listSubmissionsForPaper(getStore(c.env), id);
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
  const paper = await findPaperById(getStore(c.env), id);
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

  const questions = await listQuestions(getStore(c.env), id);
  if (questions.length === 0) {
    return c.json({ error: "Paper has no questions" }, 400);
  }

  const { score, maxScore } = gradeAnswers(questions, answers);

  const submission = await upsertSubmission(getStore(c.env), {
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
  const submission = await findSubmission(getStore(c.env), id, user.id);
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

// ---- Unknown API routes ----
// Any /api/* request not matched above is a real 404. Without this it would
// fall through to the SPA fallback below and return index.html with status 200
// (review finding 2), forcing API clients to parse HTML on a "success". Return
// machine-readable JSON instead.
app.all("/api/*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

// ---- Static assets / SPA fallback ----
// Any request not handled by an /api route is served from the assets binding.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

// Re-export the Durable Object class so wrangler can bind it (see the
// durable_objects.bindings + migrations entry in wrangler.jsonc).
export { DataStore } from "./store";
