// JSON endpoint backing the /ledger page's live-poll. Cheap query over the
// existing union view.

import { NextResponse } from "next/server";
import { getLedger } from "@/lib/ledger";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { headers, deny } = enforceRateLimit(req, "ledger", {
    capacity: 60,
    windowMs: 60_000,
  });
  if (deny) return deny;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "150");
  const entries = await getLedger(Math.min(Math.max(limit, 10), 250));
  return NextResponse.json(
    {
      entries: entries.map((e) => ({
        ts: e.ts.toISOString(),
        god_id: e.god_id,
        kind: e.kind,
        tx_hash: e.tx_hash,
        detail: e.detail,
        prophecy_id: e.prophecy_id ?? null,
        consult_id: e.consult_id ?? null,
      })),
    },
    { headers },
  );
}
