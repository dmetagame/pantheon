-- Track the bond-pool slash step independently from prophecy settlement.
-- A settled prophecy must remain complete even if a CEP18 refund transfer
-- fails, but the refund attempt should be visible and retryable.
ALTER TABLE prophecies
  ADD COLUMN IF NOT EXISTS slash_status       TEXT,
  ADD COLUMN IF NOT EXISTS slash_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS slash_error        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_slash_status_check'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_slash_status_check
      CHECK (
        slash_status IS NULL
        OR slash_status IN (
          'not_applicable',
          'processing',
          'done',
          'skipped',
          'failed'
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS prophecies_slash_retry_idx
  ON prophecies (settled_at)
  WHERE settled_at IS NOT NULL
    AND brier_bp IS NOT NULL
    AND (
      slash_status IS NULL
      OR slash_status IN ('failed', 'processing')
    );
