-- On-chain receipt for each consultation. The petitioner signs a tiny
-- self-transfer whose transfer-id is the lower 8 bytes of
-- keccak256(godId || question || answer || settle_tx_hash).
--
-- Anyone with (question, answer, settleTx) can recompute the hash and find
-- the matching receipt tx on cspr.live — no contract trust required.
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS receipt_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS receipt_id_hex  TEXT;
