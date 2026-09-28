/**
 * SQLite-backed Durable Object owning ALL persistent state for the app.
 *
 * This replaces the former Cloudflare D1 database. The schema (users,
 * sessions, test_papers, questions, submissions, login_attempts) is created
 * on first access from the statements formerly kept under migrations/*.sql,
 * so the app deploys live from a bare `wrangler deploy` with zero manual
 * resource creation and no database_id.
 *
 * State is accessed through `this.ctx.storage.sql` (SqlStorage). Each RPC
 * method mirrors a former D1 helper and returns plain row objects so callers
 * see the same shapes they saw with D1.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  Bindings,
  LoginAttemptRow,
  Role,
  SessionRow,
  UserRow,
} from "./db";
import type {
  PaperRow,
  QuestionRow,
  SubmissionRow,
  SubmissionWithStudent,
} from "./papers";

// Embedded schema (formerly migrations/0001_init.sql, 0002_papers.sql,
// 0003_login_attempts.sql). Column names, types, UNIQUE constraints and the
// AUTOINCREMENT integer PKs are identical to the D1 migrations, and
// CURRENT_TIMESTAMP defaults are kept so created_at/submitted_at strings retain
// the same format.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'prof')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS test_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  subject TEXT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES test_papers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT,
  correct_answer TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES test_papers(id),
  student_id INTEGER NOT NULL REFERENCES users(id),
  answers TEXT NOT NULL,
  score INTEGER,
  max_score INTEGER,
  submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(paper_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_test_papers_author_id ON test_papers(author_id);
CREATE INDEX IF NOT EXISTS idx_test_papers_published ON test_papers(published);
CREATE INDEX IF NOT EXISTS idx_questions_paper_id ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_submissions_paper_id ON submissions(paper_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student_id ON submissions(student_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_email_ip
  ON login_attempts(email, ip);
`;

export class DataStore extends DurableObject<Bindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Initialize the schema exactly once, before any request is served.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA_SQL);
    });
  }

  private first<T>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T | null {
    const rows = this.sql.exec(query, ...bindings).toArray() as T[];
    return rows.length > 0 ? rows[0] : null;
  }

  private all<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  private run(query: string, ...bindings: SqlStorageValue[]): number {
    return this.sql.exec(query, ...bindings).rowsWritten;
  }

  // ---- users ----

  async findUserByEmail(email: string): Promise<UserRow | null> {
    return this.first<UserRow>("SELECT * FROM users WHERE email = ?", email);
  }

  async findUserById(id: number): Promise<UserRow | null> {
    return this.first<UserRow>("SELECT * FROM users WHERE id = ?", id);
  }

  async insertUser(params: {
    email: string;
    name: string;
    role: Role;
    passwordHash: string;
    passwordSalt: string;
  }): Promise<UserRow> {
    const row = this.first<UserRow>(
      `INSERT INTO users (email, name, role, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
      params.email,
      params.name,
      params.role,
      params.passwordHash,
      params.passwordSalt
    );
    if (!row) throw new Error("Failed to insert user");
    return row;
  }

  // ---- sessions ----

  async createSession(params: {
    id: string;
    userId: number;
    expiresAt: string;
  }): Promise<void> {
    this.run(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
      params.id,
      params.userId,
      params.expiresAt
    );
  }

  async findSession(
    sessionId: string
  ): Promise<{ session: SessionRow; user: UserRow } | null> {
    const session = this.first<SessionRow>(
      "SELECT * FROM sessions WHERE id = ?",
      sessionId
    );
    if (!session) return null;

    // Expired sessions are treated as invalid and cleaned up.
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      this.run("DELETE FROM sessions WHERE id = ?", sessionId);
      return null;
    }

    const user = this.first<UserRow>(
      "SELECT * FROM users WHERE id = ?",
      session.user_id
    );
    if (!user) return null;

    return { session, user };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.run("DELETE FROM sessions WHERE id = ?", sessionId);
  }

  async deleteSessionsForUser(userId: number): Promise<number> {
    return this.run("DELETE FROM sessions WHERE user_id = ?", userId);
  }

  async deleteExpiredSessions(nowIso: string): Promise<number> {
    return this.run("DELETE FROM sessions WHERE expires_at <= ?", nowIso);
  }

  // ---- login throttling ----

  async findLoginAttempt(
    email: string,
    ip: string
  ): Promise<LoginAttemptRow | null> {
    return this.first<LoginAttemptRow>(
      "SELECT * FROM login_attempts WHERE email = ? AND ip = ?",
      email,
      ip
    );
  }

  async recordFailedLogin(params: {
    email: string;
    ip: string;
    windowStart: string;
    failures: number;
    lockedUntil: string | null;
  }): Promise<void> {
    this.run(
      `INSERT INTO login_attempts (email, ip, failures, window_start, locked_until)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email, ip)
       DO UPDATE SET failures = excluded.failures,
                     window_start = excluded.window_start,
                     locked_until = excluded.locked_until`,
      params.email,
      params.ip,
      params.failures,
      params.windowStart,
      params.lockedUntil
    );
  }

  async clearLoginAttempts(email: string, ip: string): Promise<void> {
    this.run(
      "DELETE FROM login_attempts WHERE email = ? AND ip = ?",
      email,
      ip
    );
  }

  // ---- papers ----

  async createPaper(params: {
    title: string;
    description: string | null;
    subject: string | null;
    authorId: number;
  }): Promise<PaperRow> {
    const row = this.first<PaperRow>(
      `INSERT INTO test_papers (title, description, subject, author_id)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
      params.title,
      params.description,
      params.subject,
      params.authorId
    );
    if (!row) throw new Error("Failed to insert paper");
    return row;
  }

  async findPaperById(id: number): Promise<PaperRow | null> {
    return this.first<PaperRow>("SELECT * FROM test_papers WHERE id = ?", id);
  }

  async updatePaper(
    id: number,
    params: {
      title: string;
      description: string | null;
      subject: string | null;
      published: number;
    }
  ): Promise<PaperRow | null> {
    return this.first<PaperRow>(
      `UPDATE test_papers
       SET title = ?, description = ?, subject = ?, published = ?
       WHERE id = ?
       RETURNING *`,
      params.title,
      params.description,
      params.subject,
      params.published,
      id
    );
  }

  async deletePaper(id: number): Promise<void> {
    // Clean up dependents first (explicit cascade, matching prior behavior).
    this.run("DELETE FROM questions WHERE paper_id = ?", id);
    this.run("DELETE FROM submissions WHERE paper_id = ?", id);
    this.run("DELETE FROM test_papers WHERE id = ?", id);
  }

  async listPapersByAuthor(authorId: number): Promise<PaperRow[]> {
    return this.all<PaperRow>(
      "SELECT * FROM test_papers WHERE author_id = ? ORDER BY created_at DESC, id DESC",
      authorId
    );
  }

  async listPublishedPapers(): Promise<PaperRow[]> {
    return this.all<PaperRow>(
      "SELECT * FROM test_papers WHERE published = 1 ORDER BY created_at DESC, id DESC"
    );
  }

  // ---- questions ----

  async addQuestion(params: {
    paperId: number;
    position: number;
    prompt: string;
    options: string | null;
    correctAnswer: string;
    points: number;
  }): Promise<QuestionRow> {
    const row = this.first<QuestionRow>(
      `INSERT INTO questions (paper_id, position, prompt, options, correct_answer, points)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
      params.paperId,
      params.position,
      params.prompt,
      params.options,
      params.correctAnswer,
      params.points
    );
    if (!row) throw new Error("Failed to insert question");
    return row;
  }

  async listQuestions(paperId: number): Promise<QuestionRow[]> {
    return this.all<QuestionRow>(
      "SELECT * FROM questions WHERE paper_id = ? ORDER BY position ASC, id ASC",
      paperId
    );
  }

  async nextQuestionPosition(paperId: number): Promise<number> {
    const row = this.first<{ maxpos: number }>(
      "SELECT COALESCE(MAX(position), 0) AS maxpos FROM questions WHERE paper_id = ?",
      paperId
    );
    return (row?.maxpos ?? 0) + 1;
  }

  // ---- submissions ----

  async upsertSubmission(params: {
    paperId: number;
    studentId: number;
    answers: string;
    score: number;
    maxScore: number;
  }): Promise<SubmissionRow> {
    const row = this.first<SubmissionRow>(
      `INSERT INTO submissions (paper_id, student_id, answers, score, max_score, submitted_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(paper_id, student_id)
       DO UPDATE SET answers = excluded.answers,
                     score = excluded.score,
                     max_score = excluded.max_score,
                     submitted_at = CURRENT_TIMESTAMP
       RETURNING *`,
      params.paperId,
      params.studentId,
      params.answers,
      params.score,
      params.maxScore
    );
    if (!row) throw new Error("Failed to upsert submission");
    return row;
  }

  async findSubmission(
    paperId: number,
    studentId: number
  ): Promise<SubmissionRow | null> {
    return this.first<SubmissionRow>(
      "SELECT * FROM submissions WHERE paper_id = ? AND student_id = ?",
      paperId,
      studentId
    );
  }

  async listSubmissionsForPaper(
    paperId: number
  ): Promise<SubmissionWithStudent[]> {
    return this.all<SubmissionWithStudent>(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM submissions s
       JOIN users u ON u.id = s.student_id
       WHERE s.paper_id = ?
       ORDER BY s.submitted_at DESC, s.id DESC`,
      paperId
    );
  }
}
