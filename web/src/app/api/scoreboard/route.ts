import { NextResponse } from "next/server";
import { getScoreboard } from "@/lib/scoreboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gods = await getScoreboard();
  return NextResponse.json({ gods });
}
