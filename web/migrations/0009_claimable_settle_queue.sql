-- Claimable-settlement index. Legacy rows from before settlement specs were
-- persisted can remain visible without inflating the live settlement queue.
CREATE INDEX IF NOT EXISTS prophecies_claimable_settle_queue_idx
  ON prophecies (settles_at)
  WHERE settled_at IS NULL
    AND on_chain_id IS NOT NULL
    AND settlement_feed IS NOT NULL
    AND settlement_comparator IS NOT NULL
    AND settlement_threshold IS NOT NULL;
