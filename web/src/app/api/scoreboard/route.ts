import { NextResponse } from "next/server";
import { getScoreboard } from "@/lib/scoreboard";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Scoreboard hits cspr.cloud + chain RPCs per request. 60/min per IP is
  // generous for legitimate polling, tight enough to deflect a basic flood.
  const { headers, deny } = enforceRateLimit(req, "scoreboard", {
    capacity: 60,
    windowMs: 60_000,
  });
  if (deny) return deny;
  const gods = await getScoreboard();
  return NextResponse.json({ gods }, { headers });
}
