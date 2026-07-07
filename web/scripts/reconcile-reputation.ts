// Replay settled DB outcomes into the configured Reputation contract.
//
// Default mode only records rows that have no reputation tx/backfill marker,
// which is safe for normal cron recovery. For a fresh Reputation redeploy,
// set REPLAY_ALL_REPUTATION=1 to rebuild the chain EWMA from the DB's settled
// rows and replace old reputation tx hashes with the new deploy hashes.

import postgres from "postgres";
import {
  readReputationFromChain,
  recordOutcomeOnChain,
  type ChainReputation,
} from "@pantheon/sdk";

const GOD_IDS = ["demeter", "hermes", "apollo"] as const;

interface SettledRow {
  id: number;
  god_id: (typeof GOD_IDS)[number];
  on_chain_id: string;
  brier_bp: number;
  settled_at: Date;
  reputation_tx_hash: string | null;
  reputation_backfilled: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function describeChain(rep: ChainReputation | null): string {
  if (!rep) return "no entry";
  return `settled=${rep.prophecies_settled}, accuracy_bp=${rep.accuracyBp}`;
}

async function main(): Promise<void> {
  const connectionString = requireEnv("DATABASE_URL");
  const replayAll = process.env.REPLAY_ALL_REPUTATION === "1";
  const dryRun = process.env.DRY_RUN === "1";

  if (process.env.REPUTATION_OUTCOME_ENTRYPOINT !== "record_prophecy_outcome") {
    throw new Error(
      "Set REPUTATION_OUTCOME_ENTRYPOINT=record_prophecy_outcome only after deploying a Reputation contract with that entrypoint; replaying against the legacy locked contract is unsafe.",
    );
  }

  const sql = postgres(connectionString, {
    ssl: connectionString.includes("neon.tech") ? "require" : undefined,
    max: 1,
  });

  try {
    for (const godId of GOD_IDS) {
      const before = await readReputationFromChain(godId);
      console.log(`${godId}: chain before: ${describeChain(before)}`);

      const rows = (await sql`
        SELECT id, god_id, on_chain_id, brier_bp, settled_at,
               reputation_tx_hash, reputation_backfilled
        FROM prophecies
        WHERE god_id = ${godId}
          AND settled_at IS NOT NULL
          AND brier_bp IS NOT NULL
          AND on_chain_id IS NOT NULL
          AND ${
            replayAll
              ? sql`TRUE`
              : sql`reputation_tx_hash IS NULL AND NOT reputation_backfilled`
          }
        ORDER BY settled_at ASC, id ASC;
      `) as unknown as SettledRow[];

      if (rows.length === 0) {
        console.log(`${godId}: no rows to replay`);
        continue;
      }

      console.log(
        `${godId}: replaying ${rows.length} settled outcomes (${replayAll ? "all rows" : "missing rows only"})`,
      );

      for (const row of rows) {
        if (dryRun) {
          console.log(
            `${godId}: dry-run row ${row.id}, prophecy ${row.on_chain_id}, brier ${row.brier_bp}`,
          );
          continue;
        }

        const txHash = await recordOutcomeOnChain({
          godId,
          prophecyId: BigInt(row.on_chain_id),
          brierBp: row.brier_bp,
          settledAtMs: new Date(row.settled_at).getTime(),
          entryPoint: "record_prophecy_outcome",
        });
        await sql`
          UPDATE prophecies
          SET reputation_tx_hash = ${txHash},
              reputation_backfilled = FALSE
          WHERE id = ${row.id};
        `;
        console.log(`${godId}: row ${row.id} -> ${txHash}`);
      }

      const after = await readReputationFromChain(godId);
      console.log(`${godId}: chain after: ${describeChain(after)}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
