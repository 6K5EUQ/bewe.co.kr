// ── SQLite (users + mailbox) ────────────────────────────────────────────────
// Single app.db under data/. Holds registered users (each owns username@MAIL_DOMAIN)
// and their stored mail (in/out). Mail bodies can be large, so a real DB rather
// than the JSON files used elsewhere in this app.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT UNIQUE NOT NULL,              -- local-part; email = username@MAIL_DOMAIN
  pass_hash    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | active | admin
  backup_email TEXT,                              -- verified forward target (P5)
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,                    -- owning mailbox
  direction  TEXT NOT NULL,                       -- in | out
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT,
  body_text  TEXT,
  body_html  TEXT,
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, created_at DESC);
`);

module.exports = db;
