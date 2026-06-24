import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { GODS, getBrief, prophesy, type GodId } from "@pantheon/agents";
import { confirmPublishedId, publishOnChain } from "@pantheon/sdk";
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

  // Wait for finalization and recover the on-chain id from the
  // ProphecyPublished event so /settle can call the registry. If the node is
  // slow we still persist the row — a sweeper can backfill on_chain_id later.
  let onChainId: bigint | null = null;
  let confirmError: string | null = null;
  try {
    onChainId = await confirmPublishedId(txHash);
  } catch (e) {
    confirmError = e instanceof Error ? e.message : String(e);
  }

  const [row] = await sql`
    INSERT INTO prophecies
      (god_id, on_chain_id, tx_hash, question, claim, confidence_bp, reasoning, oracle_source, settles_at)
    VALUES (
      ${p.godId},
      ${onChainId === null ? null : onChainId.toString()},
      ${txHash},
      ${p.question},
      ${p.claim === "yes"},
      ${confidenceBp},
      ${p.reasoning},
      ${oracleSource},
      ${settlesAt}
    )
    RETURNING id, on_chain_id, settles_at;
  `;

  return NextResponse.json({
    ok: true,
    id: row.id,
    onChainId: row.on_chain_id,
    godId,
    txHash,
    confirmError,
    question: p.question,
    settlesAt: row.settles_at,
  });
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

