// Database setup for ILRCensus (SQLite via better-sqlite3).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'ilrcensus.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','enumerator')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  zone TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unvisited'
    CHECK (status IN ('unvisited','enumerated','vacant','revisit','declined')),
  note TEXT NOT NULL DEFAULT '',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  resident_code TEXT NOT NULL UNIQUE,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  tenure TEXT NOT NULL CHECK (tenure IN ('owner','tenant','caretaker')),
  head_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  landlord_name TEXT NOT NULL DEFAULT '',
  landlord_phone TEXT NOT NULL DEFAULT '',
  since_year TEXT NOT NULL DEFAULT '',
  vehicles INTEGER NOT NULL DEFAULT 0,
  consent_by TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('census','registration')),
  active INTEGER NOT NULL DEFAULT 1,
  moved_out_on TEXT,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS occupants (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT NOT NULL,
  age_band TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  tenure TEXT NOT NULL CHECK (tenure IN ('owner','tenant','caretaker')),
  landlord_name TEXT NOT NULL DEFAULT '',
  landlord_phone TEXT NOT NULL DEFAULT '',
  move_in TEXT NOT NULL DEFAULT '',
  occupants_json TEXT NOT NULL DEFAULT '[]',
  consent_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  household_id INTEGER REFERENCES households(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_households_unit ON households(unit_id, active);
CREATE INDEX IF NOT EXISTS idx_occupants_household ON occupants(household_id);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
`);

module.exports = db;
