-- Atomic reservations for the public petition endpoint.
-- Each reserved run can trigger at most one paid consult, so this table is
-- the cross-instance spend gate for the browser demo.
CREATE TABLE IF NOT EXISTS petition_runs (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'completed', 'failed')),
  consult_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS petition_runs_recent_idx
  ON petition_runs (created_at);

CREATE INDEX IF NOT EXISTS petition_runs_client_recent_idx
  ON petition_runs (client_id, created_at);
