import { NextResponse } from "next/server";
import {
  COMPARATORS,
  SETTLEMENT_FEEDS,
  settleFromSpec,
  type Comparator,
  type SettlementFeed,
} from "@pantheon/agents";
import { recordOutcomeOnChain, settleOnChain } from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

interface DuePropecy {
  id: number;
  god_id: string;
  on_chain_id: string | null;
  claim: boolean;
  confidence_bp: number;
  settlement_feed: string | null;
  settlement_comparator: string | null;
  settlement_threshold: string | null;
}

interface SettleSummary {
  id: number;
  godId: string;
  onChainId: string | null;
  truth?: boolean;
  brierBp?: number;
  settleTxHash?: string;
  reputationTxHash?: string;
  error?: string;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // FOR UPDATE SKIP LOCKED guarantees that two concurrent cron runs can't
  // pick the same row — without this, both would call Reputation.record_outcome
  // for the same prophecy and permanently double-count its Brier. The lock is
  // held for the duration of the chain calls; concurrent runs simply skip
  // these rows and pick up other due prophecies.
  const results: SettleSummary[] = [];
  let considered = 0;

  await sql.begin(async (tx) => {
    const due = (await tx`
      SELECT id, god_id, on_chain_id, claim, confidence_bp,
             settlement_feed, settlement_comparator, settlement_threshold
      FROM prophecies
      WHERE settled_at IS NULL
        AND settles_at < NOW()
        AND on_chain_id IS NOT NULL
        AND settlement_feed IS NOT NULL
      ORDER BY settles_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 5;
    `) as unknown as DuePropecy[];
    considered = due.length;

    for (const p of due) {
      const onChainIdStr = p.on_chain_id!;
      try {
        const spec = parseSpec(p);
        const reading = await settleFromSpec(spec);
        const brier = brierBp(p.claim, p.confidence_bp, reading.truth);
        const settledAtMs = Date.now();

        const settleTx = await settleOnChain({
          id: BigInt(onChainIdStr),
          truth: reading.truth,
          sourceValue: reading.note,
        });
        const repTx = await recordOutcomeOnChain({
          godId: p.god_id,
          brierBp: brier,
          settledAtMs,
        });

        await tx`
          UPDATE prophecies
          SET truth = ${reading.truth},
              brier_bp = ${brier},
              source_value = ${reading.note},
              settled_at = ${new Date(settledAtMs)},
              settle_tx_hash = ${settleTx}
          WHERE id = ${p.id};
        `;

        results.push({
          id: p.id,
          godId: p.god_id,
          onChainId: onChainIdStr,
          truth: reading.truth,
          brierBp: brier,
          settleTxHash: settleTx,
          reputationTxHash: repTx,
        });
      } catch (e) {
        results.push({
          id: p.id,
          godId: p.god_id,
          onChainId: onChainIdStr,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  return NextResponse.json({
    considered,
    settled: results.filter((r) => !r.error).length,
    results,
  });
}

function parseSpec(p: DuePropecy): {
  feed: SettlementFeed;
  comparator: Comparator;
  threshold: number;
} {
  const { settlement_feed, settlement_comparator, settlement_threshold } = p;
  if (!settlement_feed || !settlement_comparator || settlement_threshold == null) {
    throw new Error(`prophecy ${p.id} missing settlement spec`);
  }
  if (!(SETTLEMENT_FEEDS as readonly string[]).includes(settlement_feed)) {
    throw new Error(`prophecy ${p.id} has unknown feed ${settlement_feed}`);
  }
  if (!(COMPARATORS as readonly string[]).includes(settlement_comparator)) {
    throw new Error(
      `prophecy ${p.id} has unknown comparator ${settlement_comparator}`,
    );
  }
  return {
    feed: settlement_feed as SettlementFeed,
    comparator: settlement_comparator as Comparator,
    threshold: Number(settlement_threshold),
  };
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

function brierBp(claim: boolean, confidenceBp: number, truth: boolean): number {
  const pTruthBp = claim === truth ? confidenceBp : 10_000 - confidenceBp;
  const diff = 10_000 - pTruthBp;
  return Math.floor((diff * diff) / 10_000);
}
