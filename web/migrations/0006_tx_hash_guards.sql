-- Future on-chain ledger rows must carry real Casper deploy hashes. The
-- constraints are NOT VALID so existing legacy/demo rows do not block deploys;
-- the app-side ledger filter hides those rows until the production DB is
-- cleaned and the constraints can be validated.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_tx_hash_format'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_tx_hash_format
      CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_propose_tx_hash_format'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_propose_tx_hash_format
      CHECK (propose_tx_hash IS NULL OR propose_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_approve_tx_hash_format'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_approve_tx_hash_format
      CHECK (approve_tx_hash IS NULL OR approve_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_settle_tx_hash_format'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_settle_tx_hash_format
      CHECK (settle_tx_hash IS NULL OR settle_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_reputation_tx_hash_format'
  ) THEN
    ALTER TABLE prophecies
      ADD CONSTRAINT prophecies_reputation_tx_hash_format
      CHECK (reputation_tx_hash IS NULL OR reputation_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consultations_payment_tx_hash_format'
  ) THEN
    ALTER TABLE consultations
      ADD CONSTRAINT consultations_payment_tx_hash_format
      CHECK (payment_tx_hash IS NULL OR payment_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consultations_receipt_tx_hash_format'
  ) THEN
    ALTER TABLE consultations
      ADD CONSTRAINT consultations_receipt_tx_hash_format
      CHECK (receipt_tx_hash IS NULL OR receipt_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consultations_refund_tx_hash_format'
  ) THEN
    ALTER TABLE consultations
      ADD CONSTRAINT consultations_refund_tx_hash_format
      CHECK (refund_tx_hash IS NULL OR refund_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
  END IF;
END $$;
