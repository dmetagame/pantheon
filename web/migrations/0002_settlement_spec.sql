ALTER TABLE prophecies
  ADD COLUMN IF NOT EXISTS settlement_feed       TEXT,
  ADD COLUMN IF NOT EXISTS settlement_comparator TEXT,
  ADD COLUMN IF NOT EXISTS settlement_threshold  NUMERIC(20, 8);
