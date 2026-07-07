import { NextResponse } from "next/server";
import { readReputationFromChain, recordOutcomeOnChain } from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

const GOD_IDS = ["apollo", "demeter", "hermes"] as const;

type Action =
  | "migrate-and-repair"
  | "preflight"
  | "clear-reputation-markers"
  | "reputation-batch";

interface Body {
  action?: Action;
  confirm?: string;
  limit?: number;
}

interface ReputationRow {
  id: number;
  god_id: (typeof GOD_IDS)[number];
  on_chain_id: string;
  brier_bp: number;
  settled_at: Date;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "migrate-and-repair") {
      await ensureSchema();
      await repairInvalidHashes();
      await validateConstraints();
      return NextResponse.json({
        ok: true,
        action: body.action,
        preflight: await preflight(),
      });
    }

    if (body.action === "preflight") {
      return NextResponse.json({
        ok: true,
        action: body.action,
        preflight: await preflight(),
      });
    }

    if (body.action === "clear-reputation-markers") {
      if (body.confirm !== "clear-reputation-markers") {
        return NextResponse.json(
          { error: "confirm must equal clear-reputation-markers" },
          { status: 400 },
        );
      }
      const rows = (await sql`
        UPDATE prophecies
        SET reputation_tx_hash = NULL,
            reputation_backfilled = FALSE
        WHERE settled_at IS NOT NULL
          AND brier_bp IS NOT NULL
          AND on_chain_id IS NOT NULL
        RETURNING id;
      `) as unknown as Array<{ id: number }>;
      return NextResponse.json({
        ok: true,
        action: body.action,
        cleared: rows.length,
        preflight: await preflight(),
      });
    }

    if (body.action === "reputation-batch") {
      if (process.env.REPUTATION_OUTCOME_ENTRYPOINT !== "record_prophecy_outcome") {
        return NextResponse.json(
          {
            error:
              "reputation-batch requires REPUTATION_OUTCOME_ENTRYPOINT=record_prophecy_outcome and a deployed Reputation contract with that entrypoint",
          },
          { status: 409 },
        );
      }
      const limit = Math.min(Math.max(body.limit ?? 1, 1), 3);
      const results = await replayReputationBatch(limit);
      return NextResponse.json({
        ok: true,
        action: body.action,
        limit,
        results,
        preflight: await preflight(),
      });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function ensureSchema(): Promise<void> {
  await sql`
    ALTER TABLE consultations
      ADD COLUMN IF NOT EXISTS refund_tx_hash     TEXT,
      ADD COLUMN IF NOT EXISTS refund_amount      NUMERIC(40, 0),
      ADD COLUMN IF NOT EXISTS refund_prophecy_id BIGINT;
  `;
  await sql`
    ALTER TABLE prophecies
      ADD COLUMN IF NOT EXISTS reputation_tx_hash    TEXT,
      ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS slash_status          TEXT,
      ADD COLUMN IF NOT EXISTS slash_attempted_at    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS slash_error           TEXT,
      ADD COLUMN IF NOT EXISTS reputation_backfilled BOOLEAN NOT NULL DEFAULT FALSE;
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS consultations_recent_per_god_idx
      ON consultations (god_id, created_at DESC);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS prophecies_settle_queue_idx
      ON prophecies (settles_at)
      WHERE settled_at IS NULL
        AND on_chain_id IS NOT NULL
        AND settlement_feed IS NOT NULL;
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS prophecies_claimable_settle_queue_idx
      ON prophecies (settles_at)
      WHERE settled_at IS NULL
        AND on_chain_id IS NOT NULL
        AND settlement_feed IS NOT NULL
        AND settlement_comparator IS NOT NULL
        AND settlement_threshold IS NOT NULL;
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS prophecies_slash_retry_idx
      ON prophecies (settled_at)
      WHERE settled_at IS NOT NULL
        AND brier_bp IS NOT NULL
        AND (
          slash_status IS NULL
          OR slash_status IN ('failed', 'processing')
        );
  `;

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_tx_hash_format') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_tx_hash_format
          CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_propose_tx_hash_format') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_propose_tx_hash_format
          CHECK (propose_tx_hash IS NULL OR propose_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_approve_tx_hash_format') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_approve_tx_hash_format
          CHECK (approve_tx_hash IS NULL OR approve_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_settle_tx_hash_format') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_settle_tx_hash_format
          CHECK (settle_tx_hash IS NULL OR settle_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_reputation_tx_hash_format') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_reputation_tx_hash_format
          CHECK (reputation_tx_hash IS NULL OR reputation_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consultations_payment_tx_hash_format') THEN
        ALTER TABLE consultations ADD CONSTRAINT consultations_payment_tx_hash_format
          CHECK (payment_tx_hash IS NULL OR payment_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consultations_receipt_tx_hash_format') THEN
        ALTER TABLE consultations ADD CONSTRAINT consultations_receipt_tx_hash_format
          CHECK (receipt_tx_hash IS NULL OR receipt_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consultations_refund_tx_hash_format') THEN
        ALTER TABLE consultations ADD CONSTRAINT consultations_refund_tx_hash_format
          CHECK (refund_tx_hash IS NULL OR refund_tx_hash ~ '^[0-9a-fA-F]{64}$') NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prophecies_slash_status_check') THEN
        ALTER TABLE prophecies ADD CONSTRAINT prophecies_slash_status_check
          CHECK (
            slash_status IS NULL OR slash_status IN (
              'not_applicable',
              'processing',
              'done',
              'skipped',
              'failed'
            )
          ) NOT VALID;
      END IF;
    END $$;
  `);
}

async function repairInvalidHashes(): Promise<void> {
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
}

async function validateConstraints(): Promise<void> {
  const names = [
    "prophecies_tx_hash_format",
    "prophecies_propose_tx_hash_format",
    "prophecies_approve_tx_hash_format",
    "prophecies_settle_tx_hash_format",
    "prophecies_reputation_tx_hash_format",
    "consultations_payment_tx_hash_format",
    "consultations_receipt_tx_hash_format",
    "consultations_refund_tx_hash_format",
    "prophecies_slash_status_check",
  ];
  for (const name of names) {
    const table = name.startsWith("consultations_")
      ? "consultations"
      : "prophecies";
    await sql.unsafe(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
  }
}

async function replayReputationBatch(limit: number) {
  const rows = (await sql`
    SELECT id, god_id, on_chain_id, brier_bp, settled_at
    FROM prophecies
    WHERE settled_at IS NOT NULL
      AND brier_bp IS NOT NULL
      AND on_chain_id IS NOT NULL
      AND reputation_tx_hash IS NULL
      AND NOT reputation_backfilled
    ORDER BY god_id ASC, settled_at ASC, id ASC
    LIMIT ${limit};
  `) as unknown as ReputationRow[];

  const results = [];
  for (const row of rows) {
    const txHash = await recordOutcomeOnChain({
      godId: row.god_id,
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
    results.push({
      id: row.id,
      godId: row.god_id,
      onChainId: row.on_chain_id,
      brierBp: row.brier_bp,
      txHash,
    });
  }
  return results;
}

async function preflight() {
  const [invalid] = (await sql`
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
  `) as unknown as Array<{ count: number }>;

  const readyOverdue = (await sql`
    SELECT id, god_id, settles_at, processing_started_at
    FROM prophecies
    WHERE settled_at IS NULL
      AND on_chain_id IS NOT NULL
      AND settlement_feed IS NOT NULL
      AND settlement_comparator IS NOT NULL
      AND settlement_threshold IS NOT NULL
      AND settles_at < NOW()
      AND (
        processing_started_at IS NULL
        OR processing_started_at < NOW() - INTERVAL '10 minutes'
      )
    ORDER BY settles_at ASC
    LIMIT 20;
  `) as unknown as Array<{
    id: number;
    god_id: string;
    settles_at: Date;
    processing_started_at: Date | null;
  }>;

  const pausedOverdue = (await sql`
    SELECT id, god_id, settles_at, processing_started_at
    FROM prophecies
    WHERE settled_at IS NULL
      AND on_chain_id IS NOT NULL
      AND settlement_feed IS NOT NULL
      AND settlement_comparator IS NOT NULL
      AND settlement_threshold IS NOT NULL
      AND settles_at < NOW()
      AND processing_started_at >= NOW() - INTERVAL '10 minutes'
    ORDER BY processing_started_at DESC, settles_at ASC
    LIMIT 20;
  `) as unknown as Array<{
    id: number;
    god_id: string;
    settles_at: Date;
    processing_started_at: Date;
  }>;

  const blockedMissingSpec = (await sql`
    SELECT id, god_id, settles_at, oracle_source, question
    FROM prophecies
    WHERE settled_at IS NULL
      AND on_chain_id IS NOT NULL
      AND settles_at < NOW()
      AND (
        settlement_feed IS NULL
        OR settlement_comparator IS NULL
        OR settlement_threshold IS NULL
      )
    ORDER BY settles_at ASC
    LIMIT 20;
  `) as unknown as Array<{
    id: number;
    god_id: string;
    settles_at: Date;
    oracle_source: string;
    question: string;
  }>;

  const reputationRows = (await sql`
    SELECT god_id,
           COUNT(*) FILTER (
             WHERE settled_at IS NOT NULL
               AND brier_bp IS NOT NULL
               AND on_chain_id IS NOT NULL
           )::int AS settled_rows,
           COUNT(*) FILTER (
             WHERE settled_at IS NOT NULL
               AND brier_bp IS NOT NULL
               AND on_chain_id IS NOT NULL
               AND reputation_tx_hash IS NULL
               AND NOT reputation_backfilled
           )::int AS replay_pending
    FROM prophecies
    GROUP BY god_id
    ORDER BY god_id ASC;
  `) as unknown as Array<{
    god_id: string;
    settled_rows: number;
    replay_pending: number;
  }>;

  const chain = await Promise.all(
    GOD_IDS.map(async (godId) => {
      const rep = await readReputationFromChain(godId).catch(() => null);
      return {
        godId,
        accuracyBp: rep?.accuracyBp ?? null,
        reputationBp: rep ? 10_000 - rep.accuracyBp : null,
        settled: rep?.prophecies_settled ?? null,
      };
    }),
  );

  return {
    invalidHashRows: invalid.count,
    overdue: readyOverdue,
    settleQueueReady: readyOverdue,
    settleQueuePaused: pausedOverdue,
    blockedMissingSpec,
    reputationRows,
    chain,
  };
}
