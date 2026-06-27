import { NextResponse } from "next/server";
import { GODS, consult, type GodId } from "@pantheon/agents";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const OFFERING_PRICE_MICRO_USDC = "200000"; // 0.20 USDC

export async function POST(
  req: Request,
  { params }: { params: Promise<{ god: string }> },
) {
  const { god: godId } = await params;
  if (!(godId in GODS)) {
    return NextResponse.json({ error: "unknown god" }, { status: 404 });
  }

  // x402 verification isn't wired yet (Day 18-20). Until it is, default-deny:
  // an unsigned `x-payment` header would mean any client gets free LLM calls.
  // For internal testing, set CONSULT_DEMO_SECRET and pass it as a bearer.
  const demoSecret = process.env.CONSULT_DEMO_SECRET;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const isDemoAuthorized = !!demoSecret && bearer === demoSecret;
  if (!isDemoAuthorized) {
    return new Response(
      JSON.stringify({
        x402Version: 1,
        error:
          "Payment required to consult the god. (x402 verification is not yet enabled; this endpoint is closed.)",
        accepts: [
          {
            scheme: "exact",
            network: "casper-test",
            asset: "USDC",
            amount: OFFERING_PRICE_MICRO_USDC,
            payTo: process.env[`${godId.toUpperCase()}_PUBLIC_KEY`] ?? "",
            resource: `/api/consult/${godId}`,
            description: `Offering to ${GODS[godId].name} for one prophecy consultation.`,
          },
        ],
      }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  let question: string;
  try {
    const body = (await req.json()) as { question?: unknown };
    if (typeof body.question !== "string" || body.question.length === 0) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }
    question = body.question.slice(0, 500);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const answer = await consult(godId as GodId, question);

  await sql`
    INSERT INTO consultations (god_id, question, answer, paid_amount_usdc)
    VALUES (${godId}, ${question}, ${answer}, 0.20);
  `;

  return NextResponse.json({
    god: godId,
    question,
    answer,
  });
}
