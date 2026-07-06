-- Keep "chain acknowledged before we persisted tx hashes" separate from the
-- tx hash itself. reputation_tx_hash is guarded as a real Casper deploy hash;
-- the boolean lets the DB EWMA include legacy chain-acknowledged samples
-- without fabricating a linkable hash.
ALTER TABLE prophecies
  ADD COLUMN IF NOT EXISTS reputation_backfilled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE prophecies
SET reputation_backfilled = TRUE,
    reputation_tx_hash = NULL
WHERE reputation_tx_hash = 'backfilled-pre-tier-0-review';
