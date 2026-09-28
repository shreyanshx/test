/**
 * Test-paper & assessment domain: typed data helpers for papers, questions,
 * and submissions. Queries are delegated to the SQLite-backed Durable Object
 * (see src/store.ts); toPublicQuestion and gradeAnswers remain pure.
 */

import type { Store } from "./db";

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
  store: Store,
  params: {
    title: string;
    description: string | null;
    subject: string | null;
    authorId: number;
  }
): Promise<PaperRow> {
  return store.createPaper(params);
}

export async function findPaperById(
  store: Store,
  id: number
): Promise<PaperRow | null> {
  return store.findPaperById(id);
}

export async function updatePaper(
  store: Store,
  id: number,
  params: {
    title: string;
    description: string | null;
    subject: string | null;
    published: number;
  }
): Promise<PaperRow | null> {
  return store.updatePaper(id, params);
}

export async function deletePaper(store: Store, id: number): Promise<void> {
  await store.deletePaper(id);
}

/** Papers a professor authored (drafts + published). */
export async function listPapersByAuthor(
  store: Store,
  authorId: number
): Promise<PaperRow[]> {
  return store.listPapersByAuthor(authorId);
}

/** Published papers visible to students. */
export async function listPublishedPapers(
  store: Store
): Promise<PaperRow[]> {
  return store.listPublishedPapers();
}

// ---- questions ----

export async function addQuestion(
  store: Store,
  params: {
    paperId: number;
    position: number;
    prompt: string;
    options: string | null;
    correctAnswer: string;
    points: number;
  }
): Promise<QuestionRow> {
  return store.addQuestion(params);
}

export async function listQuestions(
  store: Store,
  paperId: number
): Promise<QuestionRow[]> {
  return store.listQuestions(paperId);
}

/** Next position value for a new question in a paper (1-based). */
export async function nextQuestionPosition(
  store: Store,
  paperId: number
): Promise<number> {
  return store.nextQuestionPosition(paperId);
}

// ---- submissions ----

/** Upsert a student's single attempt for a paper (one row per pair). */
export async function upsertSubmission(
  store: Store,
  params: {
    paperId: number;
    studentId: number;
    answers: string;
    score: number;
    maxScore: number;
  }
): Promise<SubmissionRow> {
  return store.upsertSubmission(params);
}

export async function findSubmission(
  store: Store,
  paperId: number,
  studentId: number
): Promise<SubmissionRow | null> {
  return store.findSubmission(paperId, studentId);
}

/** List submissions for a paper joined with the student's name/email. */
export interface SubmissionWithStudent extends SubmissionRow {
  student_name: string;
  student_email: string;
}

export async function listSubmissionsForPaper(
  store: Store,
  paperId: number
): Promise<SubmissionWithStudent[]> {
  return store.listSubmissionsForPaper(paperId);
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
