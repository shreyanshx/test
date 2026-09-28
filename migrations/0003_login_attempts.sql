-- Login throttling: track recent failed login attempts per (email, ip) so the
-- login route can lock out password guessing. Rows are pruned opportunistically
-- once their window expires; only failures are recorded (a successful login
-- clears the bucket).

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  -- Start of the current counting window (ISO-8601).
  window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- When a lockout (if any) ends (ISO-8601); NULL when not locked.
  locked_until TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_email_ip
  ON login_attempts(email, ip);
