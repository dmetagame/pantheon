CREATE TABLE IF NOT EXISTS prophecies (
  id            BIGSERIAL PRIMARY KEY,
  god_id        TEXT NOT NULL,
  on_chain_id   BIGINT,
  tx_hash       TEXT,
  question      TEXT NOT NULL,
  claim         BOOLEAN NOT NULL,
  confidence_bp INTEGER NOT NULL CHECK (confidence_bp BETWEEN 5000 AND 10000),
  reasoning     TEXT NOT NULL,
  oracle_source TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settles_at    TIMESTAMPTZ NOT NULL,
  truth         BOOLEAN,
  brier_bp      INTEGER,
  source_value  TEXT,
  settled_at    TIMESTAMPTZ,
  settle_tx_hash TEXT
);

CREATE INDEX IF NOT EXISTS prophecies_god_id_idx ON prophecies(god_id);
CREATE INDEX IF NOT EXISTS prophecies_pending_idx ON prophecies(settles_at) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS consultations (
  id              BIGSERIAL PRIMARY KEY,
  god_id          TEXT NOT NULL,
  petitioner      TEXT,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  paid_amount_usdc NUMERIC(18,6),
  payment_tx_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS consultations_god_id_idx ON consultations(god_id);
