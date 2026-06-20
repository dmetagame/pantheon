import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { GODS, prophesy, type GodId } from "@pantheon/agents";
import { publishOnChain } from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const ORACLE_SOURCE: Record<GodId, string> = {
  demeter: "cspr.cloud/tvl",
  hermes: "pyth/hermes",
  apollo: "casper-rwa-oracle",
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ god: string }> },
) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { god: godId } = await params;
  if (!(godId in GODS)) {
    return NextResponse.json({ error: "unknown god" }, { status: 404 });
  }

  const brief = await getBrief(godId as GodId);
  const p = await prophesy(godId as GodId, brief);

  const settlesAt = new Date(p.settlesAt);
  const questionHash = createHash("sha256").update(p.question).digest();
  const confidenceBp = Math.round(p.confidence * 10_000);
  const oracleSource = ORACLE_SOURCE[p.godId];

  const txHash = await publishOnChain({
    godId: p.godId,
    questionHash: new Uint8Array(questionHash),
    claim: p.claim === "yes",
    confidenceBp,
    settlesAtMs: settlesAt.getTime(),
    oracleSource,
  });

  const [row] = await sql`
    INSERT INTO prophecies
      (god_id, tx_hash, question, claim, confidence_bp, reasoning, oracle_source, settles_at)
    VALUES (
      ${p.godId},
      ${txHash},
      ${p.question},
      ${p.claim === "yes"},
      ${confidenceBp},
      ${p.reasoning},
      ${oracleSource},
      ${settlesAt}
    )
    RETURNING id, settles_at;
  `;

  return NextResponse.json({
    ok: true,
    id: row.id,
    godId,
    txHash,
    question: p.question,
    settlesAt: row.settles_at,
  });
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

async function getBrief(godId: GodId): Promise<string> {
  // TODO Day 11-13: pull live data per god (CSPR.cloud TVL, Pyth, T-bill yield).
  const briefs: Record<GodId, string> = {
    demeter: `Casper DeFi TVL stands at $42M, +3% over 24h. Largest pool: USDC-CSPR at $8.2M.
Stablecoin yields range 4–9% APY. Two new liquidity pools launched in the last 48h.`,
    hermes: `BTC: $98,400 (-1.2% 24h). ETH: $3,820 (+0.8% 24h).
Funding rates neutral across major perps. Open interest stable. ETF flows mildly positive.`,
    apollo: `US 10Y yield: 4.31%. Tokenized T-bill flows: $12B AUM across major issuers.
Casper RWA index up 2.1% this week. Macro: CPI prints Thursday.`,
  };
  return briefs[godId];
}
