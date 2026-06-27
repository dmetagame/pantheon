-- Per-step persistence for the settlement pipeline so partial chain
-- failures (network blip, gas, node revert) don't strand prophecies or
-- create orphan PriestQuorum proposals on retry.
--
-- reputation_tx_hash: the chain tx that recorded the outcome on Reputation.
--   Previously this hash was computed and thrown away in the API response.
-- processing_started_at: optimistic lock on the row. The cron claims a row
--   by stamping this NOW(); a stale stamp older than 10 min frees the row
--   for retry (i.e. a previous run crashed).
ALTER TABLE prophecies
  ADD COLUMN IF NOT EXISTS reputation_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS prophecies_settle_queue_idx
  ON prophecies (settles_at)
  WHERE settled_at IS NULL
    AND on_chain_id IS NOT NULL
    AND settlement_feed IS NOT NULL;
