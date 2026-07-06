// Backfill reputation_backfilled for prophecies whose reputation outcome
// landed on chain before Tier 0 review added per-step persistence. We don't
// know the actual tx hashes for those calls, but we DO know which subset of DB
// rows must have been folded — because the chain's EWMA tells us.
//
// For each god:
//   1. Read chain accuracy_bp + prophecies_settled
//   2. Pull all DB-settled brier samples ordered by settled_at
//   3. Try every chronologically-ordered subset of size N = prophecies_settled
//      whose fold produces chain accuracy_bp
//   4. Mark the winning subset's rows with reputation_backfilled=true so the
//      EWMA filter includes them without fabricating a deploy hash
//
// Idempotent: rows that already have reputation_tx_hash or
// reputation_backfilled=true are left alone.

import postgres from "postgres";
import { readReputationFromChain } from "@pantheon/sdk";

const ALPHA_BP = 500;

function foldEwma(samples: number[]): number {
  if (samples.length === 0) return 0;
  let acc = samples[0];
  for (let i = 1; i < samples.length; i++) {
    acc = Math.floor((ALPHA_BP * samples[i] + (10_000 - ALPHA_BP) * acc) / 10_000);
  }
  return acc;
}

interface Candidate {
  id: number;
  brier_bp: number;
  settled_at: Date;
  reputation_tx_hash: string | null;
  reputation_backfilled: boolean;
}

/** Enumerate every size-k subset of `arr` (in original order), returning the
 *  first whose fold equals `target`. */
function findMatchingSubset(
  arr: Candidate[],
  k: number,
  target: number,
): Candidate[] | null {
  const n = arr.length;
  if (k > n) return null;
  const indices = Array.from({ length: k }, (_, i) => i);
  while (true) {
    const subset = indices.map((i) => arr[i]);
    if (foldEwma(subset.map((s) => s.brier_bp)) === target) return subset;
    // advance to next k-subset in lex order
    let i = k - 1;
    while (i >= 0 && indices[i] === n - k + i) i--;
    if (i < 0) return null;
    indices[i]++;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
  }
}

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, {
    ssl: process.env.DATABASE_URL!.includes("neon.tech") ? "require" : undefined,
    max: 1,
  });

  for (const godId of ["demeter", "hermes", "apollo"] as const) {
    const chain = await readReputationFromChain(godId);
    if (!chain) {
      console.log(`${godId}: no chain entry, skipping`);
      continue;
    }

    const candidates = (await sql`
      SELECT id, brier_bp, settled_at, reputation_tx_hash, reputation_backfilled
      FROM prophecies
      WHERE god_id = ${godId}
        AND settled_at IS NOT NULL
        AND brier_bp IS NOT NULL
      ORDER BY settled_at ASC;
    `) as unknown as Candidate[];

    const subset = findMatchingSubset(
      candidates,
      chain.prophecies_settled,
      chain.accuracyBp,
    );
    if (!subset) {
      console.log(
        `${godId}: no DB subset of size ${chain.prophecies_settled} produces chain accuracy_bp=${chain.accuracyBp}; manual investigation needed`,
      );
      continue;
    }

    const toBackfill = subset.filter(
      (s) => !s.reputation_tx_hash && !s.reputation_backfilled,
    );
    if (toBackfill.length === 0) {
      console.log(
        `${godId}: ✓ all ${chain.prophecies_settled} chain-acknowledged settlements are already tracked`,
      );
      continue;
    }

    console.log(
      `${godId}: marking ${toBackfill.length} of ${chain.prophecies_settled} rows (ids ${toBackfill.map((s) => s.id).join(", ")}) as backfilled`,
    );
    for (const row of toBackfill) {
      await sql`
        UPDATE prophecies
        SET reputation_backfilled = TRUE
        WHERE id = ${row.id};
      `;
    }
  }

  await sql.end();
  console.log("");
  console.log("Verify with: curl http://localhost:3030/api/scoreboard");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
