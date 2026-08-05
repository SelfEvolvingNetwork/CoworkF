-- Cloudflare D1 Relational Database Schema
-- Coworking Manager Software Engineering Standard Schema

-- 1. Configuration Table (Key-Value system settings)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Shifts Table
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  week_days TEXT NOT NULL, -- JSON array string e.g. '[0,1,2,3,4]'
  total_regular INTEGER NOT NULL DEFAULT 20,
  total_premium INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Members Table
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Terms Table (Subscription Registrations)
CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, -- YYYY/MM/DD
  end_date TEXT NOT NULL,   -- YYYY/MM/DD
  sessions_count INTEGER NOT NULL DEFAULT 12,
  desk_type TEXT NOT NULL DEFAULT 'regular', -- 'regular' | 'premium'
  sessions TEXT NOT NULL, -- JSON array string of Jalali session dates
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_terms_member ON terms(member_id);
CREATE INDEX IF NOT EXISTS idx_terms_shift ON terms(shift_id);

-- 5. Session Notes Table
CREATE TABLE IF NOT EXISTS session_notes (
  term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  date_str TEXT NOT NULL, -- YYYY/MM/DD
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (term_id, date_str)
);

-- 6. Session Attendance Table
CREATE TABLE IF NOT EXISTS session_attendance (
  term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  date_str TEXT NOT NULL, -- YYYY/MM/DD
  status TEXT NOT NULL, -- 'present' | 'absent' | ''
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (term_id, date_str)
);

-- 7. Calendar Overrides Table
CREATE TABLE IF NOT EXISTS calendar_overrides (
  date_str TEXT PRIMARY KEY, -- YYYY/MM/DD
  status TEXT NOT NULL -- 'holiday' | 'working'
);

-- 8. Database Metadata & Versioning
CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
