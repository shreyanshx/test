/**
 * Test-paper & assessment domain: typed D1 query helpers for papers,
 * questions, and submissions.
 */

export interface PaperRow {
  id: number;
  title: string;
  description: string | null;
  subject: string | null;
  author_id: number;
  published: number; // 0 | 1 (SQLite has no boolean)
  created_at: string;
}

export interface QuestionRow {
  id: number;
  paper_id: number;
  position: number;
  prompt: string;
  options: string | null; // JSON-encoded string[] for multiple-choice, or null
  correct_answer: string;
  points: number;
}

export interface SubmissionRow {
  id: number;
  paper_id: number;
  student_id: number;
  answers: string; // JSON-encoded map { [questionId]: answer }
  score: number | null;
  max_score: number | null;
  submitted_at: string;
}

/** Question with options decoded and correct_answer optionally stripped. */
export interface PublicQuestion {
  id: number;
  position: number;
  prompt: string;
  options: string[] | null;
  points: number;
  correct_answer?: string;
}

function parseOptions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((o) => String(o));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a stored QuestionRow into its public representation. When
 * includeAnswer is false the correct_answer field is omitted entirely
 * (students must never receive correct answers).
 */
export function toPublicQuestion(
  q: QuestionRow,
  includeAnswer: boolean
): PublicQuestion {
  const base: PublicQuestion = {
    id: q.id,
    position: q.position,
    prompt: q.prompt,
    options: parseOptions(q.options),
    points: q.points,
  };
  if (includeAnswer) {
    base.correct_answer = q.correct_answer;
  }
  return base;
}

// ---- papers ----

export async function createPaper(
  db: D1Database,
  params: {
    title: string;
    description: string | null;
    subject: string | null;
    authorId: number;
  }
): Promise<PaperRow> {
  const row = await db
    .prepare(
      `INSERT INTO test_papers (title, description, subject, author_id)
       VALUES (?, ?, ?, ?)
       RETURNING *`
    )
    .bind(params.title, params.description, params.subject, params.authorId)
    .first<PaperRow>();
  if (!row) throw new Error("Failed to insert paper");
  return row;
}

export async function findPaperById(
  db: D1Database,
  id: number
): Promise<PaperRow | null> {
  const row = await db
    .prepare("SELECT * FROM test_papers WHERE id = ?")
    .bind(id)
    .first<PaperRow>();
  return row ?? null;
}

export async function updatePaper(
  db: D1Database,
  id: number,
  params: {
    title: string;
    description: string | null;
    subject: string | null;
    published: number;
  }
): Promise<PaperRow | null> {
  const row = await db
    .prepare(
      `UPDATE test_papers
       SET title = ?, description = ?, subject = ?, published = ?
       WHERE id = ?
       RETURNING *`
    )
    .bind(
      params.title,
      params.description,
      params.subject,
      params.published,
      id
    )
    .first<PaperRow>();
  return row ?? null;
}

export async function deletePaper(db: D1Database, id: number): Promise<void> {
  // Clean up dependents first (D1 does not enforce ON DELETE CASCADE unless
  // PRAGMA foreign_keys is on, so we remove children explicitly).
  await db.batch([
    db.prepare("DELETE FROM questions WHERE paper_id = ?").bind(id),
    db.prepare("DELETE FROM submissions WHERE paper_id = ?").bind(id),
    db.prepare("DELETE FROM test_papers WHERE id = ?").bind(id),
  ]);
}

/** Papers a professor authored (drafts + published). */
export async function listPapersByAuthor(
  db: D1Database,
  authorId: number
): Promise<PaperRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM test_papers WHERE author_id = ? ORDER BY created_at DESC, id DESC"
    )
    .bind(authorId)
    .all<PaperRow>();
  return results ?? [];
}

/** Published papers visible to students. */
export async function listPublishedPapers(
  db: D1Database
): Promise<PaperRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM test_papers WHERE published = 1 ORDER BY created_at DESC, id DESC"
    )
    .all<PaperRow>();
  return results ?? [];
}

// ---- questions ----

export async function addQuestion(
  db: D1Database,
  params: {
    paperId: number;
    position: number;
    prompt: string;
    options: string | null;
    correctAnswer: string;
    points: number;
  }
): Promise<QuestionRow> {
  const row = await db
    .prepare(
      `INSERT INTO questions (paper_id, position, prompt, options, correct_answer, points)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.paperId,
      params.position,
      params.prompt,
      params.options,
      params.correctAnswer,
      params.points
    )
    .first<QuestionRow>();
  if (!row) throw new Error("Failed to insert question");
  return row;
}

export async function listQuestions(
  db: D1Database,
  paperId: number
): Promise<QuestionRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM questions WHERE paper_id = ? ORDER BY position ASC, id ASC"
    )
    .bind(paperId)
    .all<QuestionRow>();
  return results ?? [];
}

/** Next position value for a new question in a paper (1-based). */
export async function nextQuestionPosition(
  db: D1Database,
  paperId: number
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(position), 0) AS maxpos FROM questions WHERE paper_id = ?"
    )
    .bind(paperId)
    .first<{ maxpos: number }>();
  return (row?.maxpos ?? 0) + 1;
}

// ---- submissions ----

/** Upsert a student's single attempt for a paper (one row per pair). */
export async function upsertSubmission(
  db: D1Database,
  params: {
    paperId: number;
    studentId: number;
    answers: string;
    score: number;
    maxScore: number;
  }
): Promise<SubmissionRow> {
  const row = await db
    .prepare(
      `INSERT INTO submissions (paper_id, student_id, answers, score, max_score, submitted_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(paper_id, student_id)
       DO UPDATE SET answers = excluded.answers,
                     score = excluded.score,
                     max_score = excluded.max_score,
                     submitted_at = CURRENT_TIMESTAMP
       RETURNING *`
    )
    .bind(
      params.paperId,
      params.studentId,
      params.answers,
      params.score,
      params.maxScore
    )
    .first<SubmissionRow>();
  if (!row) throw new Error("Failed to upsert submission");
  return row;
}

export async function findSubmission(
  db: D1Database,
  paperId: number,
  studentId: number
): Promise<SubmissionRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM submissions WHERE paper_id = ? AND student_id = ?"
    )
    .bind(paperId, studentId)
    .first<SubmissionRow>();
  return row ?? null;
}

/** List submissions for a paper joined with the student's name/email. */
export interface SubmissionWithStudent extends SubmissionRow {
  student_name: string;
  student_email: string;
}

export async function listSubmissionsForPaper(
  db: D1Database,
  paperId: number
): Promise<SubmissionWithStudent[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM submissions s
       JOIN users u ON u.id = s.student_id
       WHERE s.paper_id = ?
       ORDER BY s.submitted_at DESC, s.id DESC`
    )
    .bind(paperId)
    .all<SubmissionWithStudent>();
  return results ?? [];
}

/**
 * Auto-grade a set of answers against the paper's questions. Answers is a
 * map of questionId -> submitted answer. Comparison is case-insensitive and
 * trims surrounding whitespace. Returns the earned score and max possible.
 */
export function gradeAnswers(
  questions: QuestionRow[],
  answers: Record<string, unknown>
): { score: number; maxScore: number } {
  let score = 0;
  let maxScore = 0;
  for (const q of questions) {
    maxScore += q.points;
    const submitted = answers[String(q.id)];
    if (typeof submitted !== "string" && typeof submitted !== "number") {
      continue;
    }
    const a = String(submitted).trim().toLowerCase();
    const correct = q.correct_answer.trim().toLowerCase();
    if (a.length > 0 && a === correct) {
      score += q.points;
    }
  }
  return { score, maxScore };
}
