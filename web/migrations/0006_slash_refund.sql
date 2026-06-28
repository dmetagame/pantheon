-- Bond pool / slash on broken prophecy.
-- When a god's prophecy settles with brier > threshold, a fraction of the
-- god's treasury is refunded to recent petitioners. Petitioner gets a CEP18
-- transfer from the god back; we record the refund tx hash + amount on the
-- consultation row.
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS refund_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount     NUMERIC(40, 0),
  ADD COLUMN IF NOT EXISTS refund_prophecy_id BIGINT;

CREATE INDEX IF NOT EXISTS consultations_recent_per_god_idx
  ON consultations (god_id, created_at DESC);
