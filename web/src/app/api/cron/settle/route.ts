import { NextResponse } from "next/server";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

interface DuePropecy {
  id: number;
  god_id: string;
  claim: boolean;
  confidence_bp: number;
  oracle_source: string;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const due = (await sql`
    SELECT id, god_id, claim, confidence_bp, oracle_source
    FROM prophecies
    WHERE settled_at IS NULL AND settles_at < NOW()
    ORDER BY settles_at ASC
    LIMIT 20;
  `) as unknown as DuePropecy[];

  let settled = 0;
  for (const p of due) {
    const oracle = await fetchOracleValue(p.oracle_source);
    if (!oracle) continue;
    const brier = brierBp(p.claim, p.confidence_bp, oracle.truth);
    await sql`
      UPDATE prophecies
      SET truth = ${oracle.truth},
          brier_bp = ${brier},
          source_value = ${oracle.note},
          settled_at = NOW()
      WHERE id = ${p.id};
    `;
    // TODO Day 4: also call ProphecyRegistry::settle on Casper Testnet.
    settled++;
  }

  return NextResponse.json({ settled, considered: due.length });
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
