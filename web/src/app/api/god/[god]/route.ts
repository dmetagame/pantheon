import { NextResponse } from "next/server";
import { getGodDetail } from "@/lib/god";
import { GODS, type GodId } from "@pantheon/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ god: string }> },
) {
  const { god } = await params;
  if (!(god in GODS)) {
    return NextResponse.json({ error: "unknown god" }, { status: 404 });
  }
  const detail = await getGodDetail(god as GodId);
  if (!detail) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Coerce DB row dates to ISO strings so JSON consumers (MCP, etc.) get a
  // stable shape.
  return NextResponse.json({
    stats: {
      ...detail.stats,
      last_prophecy_at: detail.stats.last_prophecy_at?.toISOString() ?? null,
    },
    voice: detail.voice,
    allowedFeeds: detail.allowedFeeds,
    recent: detail.recent.map((p) => ({
      ...p,
      published_at: p.published_at.toISOString(),
      settles_at: p.settles_at.toISOString(),
      settled_at: p.settled_at?.toISOString() ?? null,
    })),
  });
}
