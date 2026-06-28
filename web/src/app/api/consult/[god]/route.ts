import { NextResponse } from "next/server";
import { GODS, consult, type GodId } from "@pantheon/agents";
import {
  buildAcceptsEnvelope,
  decodePaymentHeader,
  pubkeyToAccountKeyHex,
  settleOnFacilitator,
  verifyOnFacilitator,
  type PaymentRequirements,
} from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

const X_PAYMENT_HEADER = "x-payment";
const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ god: string }> },
) {
  const { god: godId } = await params;
  if (!(godId in GODS)) {
    return NextResponse.json({ error: "unknown god" }, { status: 404 });
  }

  const godPubkey = process.env[`${godId.toUpperCase()}_PUBLIC_KEY`];
  if (!godPubkey) {
    return NextResponse.json(
      { error: `god ${godId} has no PUBLIC_KEY configured` },
      { status: 500 },
    );
  }

  const resourceUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3030"}/api/consult/${godId}`;
  const requirements: PaymentRequirements = buildAcceptsEnvelope({
    godPublicKeyHex: godPubkey,
    resourceUrl,
    description: `Tithe to ${GODS[godId].name} for one prophecy consultation.`,
  }).accepts[0]!;

  // ─── 1. payment gate ───────────────────────────────────────────────────
  // First-class path is x402: client tries without X-Payment, gets a 402 with
  // the canonical accepts envelope, signs, retries. As a fallback for ops
  // testing we keep CONSULT_DEMO_SECRET as a bearer override — useful for the
  // local dev loop while x402 token funding is in flight.
  const demoSecret = process.env.CONSULT_DEMO_SECRET;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const isDemoAuthorized = !!demoSecret && bearer === demoSecret;

  let paidViaX402: { settleTx: string; payer: string } | null = null;

  if (!isDemoAuthorized) {
    const headerVal = req.headers.get(X_PAYMENT_HEADER);
    const paymentPayload = decodePaymentHeader(headerVal);
    if (!paymentPayload) {
      return new Response(
        JSON.stringify(
          buildAcceptsEnvelope({
            godPublicKeyHex: godPubkey,
            resourceUrl,
            description: `Tithe to ${GODS[godId].name} for one prophecy consultation.`,
          }),
        ),
        {
          status: 402,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Validate the payment payload's accepted entry against our actual
    // requirements — the client is allowed to echo it back but we must not
    // trust their copy. Compare the few fields that matter.
    const expectedPayTo = pubkeyToAccountKeyHex(godPubkey);
    if (
      paymentPayload.accepted.network !== requirements.network ||
      paymentPayload.accepted.payTo !== expectedPayTo ||
      paymentPayload.accepted.asset !== requirements.asset ||
      BigInt(paymentPayload.accepted.amount) <
        BigInt(requirements.amount)
    ) {
      return NextResponse.json(
        { error: "payment payload does not match server requirements" },
        { status: 402 },
      );
    }

    let verify;
    try {
      verify = await verifyOnFacilitator(paymentPayload, requirements);
    } catch (e) {
      return NextResponse.json(
        { error: `facilitator verify failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
    if (!verify.isValid) {
      return NextResponse.json(
        {
          error: "x402 verification rejected",
          invalidReason: verify.invalidReason,
          invalidMessage: verify.invalidMessage,
        },
        { status: 402 },
      );
    }

    // Note: settle happens AFTER we do the work, so a failed LLM call doesn't
    // burn the petitioner's tithe.
    paidViaX402 = { settleTx: "", payer: verify.payer ?? "" };
  }

  // ─── 2. parse question ─────────────────────────────────────────────────
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

  // ─── 3. do the work ────────────────────────────────────────────────────
  const answer = await consult(godId as GodId, question);

  // ─── 4. settle x402 (if we verified one) ───────────────────────────────
  if (paidViaX402 && !isDemoAuthorized) {
    const headerVal = req.headers.get(X_PAYMENT_HEADER)!;
    const paymentPayload = decodePaymentHeader(headerVal)!;
    try {
      const settle = await settleOnFacilitator(paymentPayload, requirements);
      if (!settle.success) {
        return NextResponse.json(
          {
            error: "x402 settle failed after verify succeeded",
            errorReason: settle.errorReason,
            errorMessage: settle.errorMessage,
          },
          { status: 502 },
        );
      }
      paidViaX402.settleTx = settle.transaction;
      paidViaX402.payer = settle.payer;
    } catch (e) {
      return NextResponse.json(
        { error: `facilitator settle failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
  }

  // ─── 5. persist + respond ──────────────────────────────────────────────
  const paidAmount = isDemoAuthorized ? 0.0 : Number(requirements.amount) / 1_000_000;
  await sql`
    INSERT INTO consultations (god_id, question, answer, paid_amount_usdc, payment_tx_hash, petitioner)
    VALUES (
      ${godId},
      ${question},
      ${answer},
      ${paidAmount},
      ${paidViaX402?.settleTx ?? null},
      ${paidViaX402?.payer ?? null}
    );
  `;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paidViaX402) {
    headers[X_PAYMENT_RESPONSE_HEADER] = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: paidViaX402.settleTx,
        network: requirements.network,
        payer: paidViaX402.payer,
      }),
      "utf8",
    ).toString("base64");
  }

  return new Response(
    JSON.stringify({
      god: godId,
      question,
      answer,
      payment: paidViaX402
        ? {
            settleTx: paidViaX402.settleTx,
            payer: paidViaX402.payer,
            amount: requirements.amount,
            asset: requirements.asset,
            network: requirements.network,
          }
        : { mode: "demo-bearer" },
    }),
    { status: 200, headers },
  );
}
