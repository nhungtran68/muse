-- Apply only to the dedicated connector D1 database, never to Supabase.
CREATE TABLE IF NOT EXISTS link_sessions (
  user_id TEXT PRIMARY KEY,
  envelope TEXT,
  refresh_pending INTEGER NOT NULL DEFAULT 0 CHECK (refresh_pending IN (0,1)),
  lock_id TEXT,
  lock_until INTEGER
);
