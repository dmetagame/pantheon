ALTER TABLE prophecies
  ADD COLUMN IF NOT EXISTS propose_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS approve_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS quorum_proposal_id BIGINT;
