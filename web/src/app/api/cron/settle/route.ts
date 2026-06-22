import { NextResponse } from "next/server";
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
  oracle_source: string;
}

interface SettleSummary {
  id: number;
  godId: string;
  onChainId: string | null;
  settleTxHash?: string;
  reputationTxHash?: string;
  error?: string;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Only settle rows whose publish was confirmed on chain — otherwise we have
  // no on_chain_id to pass to ProphecyRegistry::settle. A separate sweeper can
  // backfill on_chain_id for older rows.
  const due = (await sql`
    SELECT id, god_id, on_chain_id, claim, confidence_bp, oracle_source
    FROM prophecies
    WHERE settled_at IS NULL
      AND settles_at < NOW()
      AND on_chain_id IS NOT NULL
    ORDER BY settles_at ASC
    LIMIT 5;
  `) as unknown as DuePropecy[];

  const results: SettleSummary[] = [];

  for (const p of due) {
    const onChainIdStr = p.on_chain_id!;
    const oracle = await fetchOracleValue(p.oracle_source);
    if (!oracle) continue;
    const brier = brierBp(p.claim, p.confidence_bp, oracle.truth);
    const settledAtMs = Date.now();

    try {
      const settleTx = await settleOnChain({
        id: BigInt(onChainIdStr),
        truth: oracle.truth,
        sourceValue: oracle.note,
      });
      const repTx = await recordOutcomeOnChain({
        godId: p.god_id,
        brierBp: brier,
        settledAtMs,
      });

      await sql`
        UPDATE prophecies
        SET truth = ${oracle.truth},
            brier_bp = ${brier},
            source_value = ${oracle.note},
            settled_at = ${new Date(settledAtMs)},
            settle_tx_hash = ${settleTx}
        WHERE id = ${p.id};
      `;

      results.push({
        id: p.id,
        godId: p.god_id,
        onChainId: onChainIdStr,
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

  return NextResponse.json({
    considered: due.length,
    settled: results.filter((r) => !r.error).length,
    results,
  });
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

async function fetchOracleValue(
  source: string,
): Promise<{ truth: boolean; note: string } | null> {
  // TODO Day 3-4: real fetches per source (Pyth, CSPR.cloud TVL, RWA oracle).
  // Stub: 50/50 so the math runs end-to-end without external deps.
  return {
    truth: Math.random() < 0.5,
    note: `stub:${source}:${new Date().toISOString()}`,
  };
}

function brierBp(claim: boolean, confidenceBp: number, truth: boolean): number {
  const pTruthBp = claim === truth ? confidenceBp : 10_000 - confidenceBp;
  const diff = 10_000 - pTruthBp;
  return Math.floor((diff * diff) / 10_000);
}
