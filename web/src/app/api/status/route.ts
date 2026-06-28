// Concise pantheon-wide snapshot for MCP / external agents. Bundles the
// aggregate stats with each god's headline numbers so an agent can ask
// "what's happening across the whole pantheon" in one round-trip.

import { NextResponse } from "next/server";
import { getScoreboard } from "@/lib/scoreboard";
import { getPantheonStats } from "@/lib/aggregate";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { headers, deny } = enforceRateLimit(req, "status", {
    capacity: 60,
    windowMs: 60_000,
  });
  if (deny) return deny;
  const [gods, stats] = await Promise.all([
    getScoreboard(),
    getPantheonStats(),
  ]);
  const lastSpoke = gods
    .map((g) => g.last_prophecy_at)
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return NextResponse.json(
    {
    totals: {
      gods: gods.length,
      settled: stats.totalSettled,
      pending: stats.totalPending,
      consults: stats.totalConsults,
      refunds: stats.totalRefunds,
      refundedMotes: stats.totalRefundedMotes,
      chainActions: stats.totalChainActions,
    },
    lastSpokeIso: lastSpoke?.toISOString() ?? null,
    gods: gods.map((g) => ({
      id: g.id,
      name: g.name,
      domain: g.domain,
      reputationBp: g.reputationBp,
      dbReputationBp: g.dbReputationBp,
      reputationVerified:
        Math.abs(g.reputationBp - g.dbReputationBp) <= 5,
      prophecies_settled: g.prophecies_settled,
      prophecies_pending: g.prophecies_pending,
      treasuryMotes: g.treasuryMotes,
      consultPriceMotes: g.consultPriceMotes,
      publicKey: g.publicKey,
    })),
    },
    { headers },
  );
}
