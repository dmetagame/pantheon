// One-shot production data repair for the hackathon demo preflight.
//
// It removes non-Casper deploy hashes from ledger-facing tx columns, moves the
// old reputation backfill sentinel into reputation_backfilled, and validates
// the NOT VALID hash constraints after cleanup.

import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("neon.tech") ? "require" : undefined,
  max: 1,
});

async function main(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE prophecies
      SET tx_hash = CASE
            WHEN tx_hash IS NOT NULL AND tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE tx_hash
          END,
          propose_tx_hash = CASE
            WHEN propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE propose_tx_hash
          END,
          quorum_proposal_id = CASE
            WHEN propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE quorum_proposal_id
          END,
          approve_tx_hash = CASE
            WHEN approve_tx_hash IS NOT NULL AND approve_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE approve_tx_hash
          END,
          settle_tx_hash = CASE
            WHEN settle_tx_hash IS NOT NULL AND settle_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE settle_tx_hash
          END,
          reputation_backfilled = CASE
            WHEN reputation_tx_hash = 'backfilled-pre-tier-0-review'
              THEN TRUE
            ELSE reputation_backfilled
          END,
          reputation_tx_hash = CASE
            WHEN reputation_tx_hash IS NOT NULL AND reputation_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE reputation_tx_hash
          END
      WHERE (tx_hash IS NOT NULL AND tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (approve_tx_hash IS NOT NULL AND approve_tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (settle_tx_hash IS NOT NULL AND settle_tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (reputation_tx_hash IS NOT NULL AND reputation_tx_hash !~ '^[0-9a-fA-F]{64}$');
    `;
    await tx`
      UPDATE consultations
      SET payment_tx_hash = CASE
            WHEN payment_tx_hash IS NOT NULL AND payment_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE payment_tx_hash
          END,
          receipt_tx_hash = CASE
            WHEN receipt_tx_hash IS NOT NULL AND receipt_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE receipt_tx_hash
          END,
          refund_tx_hash = CASE
            WHEN refund_tx_hash IS NOT NULL AND refund_tx_hash !~ '^[0-9a-fA-F]{64}$'
              THEN NULL
            ELSE refund_tx_hash
          END
      WHERE (payment_tx_hash IS NOT NULL AND payment_tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (receipt_tx_hash IS NOT NULL AND receipt_tx_hash !~ '^[0-9a-fA-F]{64}$')
         OR (refund_tx_hash IS NOT NULL AND refund_tx_hash !~ '^[0-9a-fA-F]{64}$');
    `;
  });

  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_tx_hash_format`;
  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_propose_tx_hash_format`;
  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_approve_tx_hash_format`;
  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_settle_tx_hash_format`;
  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_reputation_tx_hash_format`;
  await sql`ALTER TABLE consultations VALIDATE CONSTRAINT consultations_payment_tx_hash_format`;
  await sql`ALTER TABLE consultations VALIDATE CONSTRAINT consultations_receipt_tx_hash_format`;
  await sql`ALTER TABLE consultations VALIDATE CONSTRAINT consultations_refund_tx_hash_format`;
  await sql`ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_slash_status_check`;

  const [invalid] = await sql<[{ count: number }]>`
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT tx_hash FROM prophecies WHERE tx_hash IS NOT NULL AND tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT propose_tx_hash FROM prophecies WHERE propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT approve_tx_hash FROM prophecies WHERE approve_tx_hash IS NOT NULL AND approve_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT settle_tx_hash FROM prophecies WHERE settle_tx_hash IS NOT NULL AND settle_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT reputation_tx_hash FROM prophecies WHERE reputation_tx_hash IS NOT NULL AND reputation_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT payment_tx_hash FROM consultations WHERE payment_tx_hash IS NOT NULL AND payment_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT receipt_tx_hash FROM consultations WHERE receipt_tx_hash IS NOT NULL AND receipt_tx_hash !~ '^[0-9a-fA-F]{64}$'
      UNION ALL
      SELECT refund_tx_hash FROM consultations WHERE refund_tx_hash IS NOT NULL AND refund_tx_hash !~ '^[0-9a-fA-F]{64}$'
    ) bad;
  `;

  console.log(`production data repair complete; invalid_hash_rows=${invalid.count}`);
}

main()
  .finally(() => sql.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
