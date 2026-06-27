import { NextResponse } from "next/server";
import { confirmPublishedId } from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

interface OrphanRow {
  id: number;
  god_id: string;
  tx_hash: string;
}

interface SweepResult {
  id: number;
  godId: string;
  onChainId?: string;
  error?: string;
}

/**
 * Backfill on_chain_id for prophecies whose publish tx confirmed but whose
 * ProphecyPublished event we never got to parse — either because the cron
 * timed out before the node had the transaction, or the node was slow.
 *
 * Run on a separate cadence from /api/cron/settle so the two jobs don't fight
 * for the same DB rows. The short per-row timeout keeps a stuck tx from
 * starving the whole sweep.
 */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const orphans = (await sql`
    SELECT id, god_id, tx_hash
    FROM prophecies
    WHERE tx_hash IS NOT NULL
      AND on_chain_id IS NULL
      AND settled_at IS NULL
    ORDER BY published_at ASC
    LIMIT 10;
  `) as unknown as OrphanRow[];

  const results: SweepResult[] = [];
  for (const o of orphans) {
    try {
      // 8s is plenty for an already-finalized tx; if the node still hasn't
      // indexed it, we'll catch it on the next sweep.
      const id = await confirmPublishedId(o.tx_hash, 8_000);
      await sql`
        UPDATE prophecies
        SET on_chain_id = ${id.toString()}
        WHERE id = ${o.id} AND on_chain_id IS NULL;
      `;
      results.push({ id: o.id, godId: o.god_id, onChainId: id.toString() });
    } catch (e) {
      results.push({
        id: o.id,
        godId: o.god_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    considered: orphans.length,
    recovered: results.filter((r) => r.onChainId).length,
    results,
  });
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}
