-- Test-paper & assessment domain: papers, questions, submissions

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
