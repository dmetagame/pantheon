import { NextResponse } from "next/server";
import { GODS, consult, type GodId } from "@pantheon/agents";
import {
  buildAcceptsEnvelope,
  decodePaymentHeader,
  pubkeyToAccountKeyHex,
  recordConsultReceiptOnChain,
  settleOnFacilitator,
  verifyOnFacilitator,
  type ConsultReceipt,
  type PaymentRequirements,
} from "@pantheon/sdk";
import sql from "@/lib/db";
import { getReputationBp } from "@/lib/scoreboard";
import { basePriceMotes, priceFromReputation } from "@/lib/pricing";

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

  // Reputation-gated pricing: calibrated gods cost more, untested gods are
  // cheap. The petitioner reads the price from the 402 envelope and signs
  // for it directly — no separate price negotiation step.
  const reputationBp = await getReputationBp(godId as GodId);
  const priceMotes = priceFromReputation(reputationBp, basePriceMotes());
  const description =
    `Tithe to ${GODS[godId as GodId].name} for one prophecy consultation. ` +
    `Reputation ${(reputationBp / 100).toFixed(1)}% sets the price.`;

  const requirements: PaymentRequirements = buildAcceptsEnvelope({
    godPublicKeyHex: godPubkey,
    resourceUrl,
    description,
    amount: priceMotes.toString(),
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
            description,
            amount: priceMotes.toString(),
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

  // ─── 5. on-chain receipt ───────────────────────────────────────────────
  // The petitioner signs a tiny self-transfer whose transfer_id is the lower
  // 8 bytes of keccak256(godId | question | answer | settle_tx_hash). Anyone
  // who knows those four can recompute the hash and find the matching
  // transfer on cspr.live — no database trust required. We only attempt this
  // when there's a real settle tx to bind to; the bearer-demo path skips it.
  let receipt: ConsultReceipt | null = null;
  if (paidViaX402?.settleTx) {
    try {
      receipt = await recordConsultReceiptOnChain({
        godId,
        question,
        answer,
        settleTxHash: paidViaX402.settleTx,
        recipientPublicKeyHex: godPubkey,
      });
    } catch (e) {
      // Don't fail the consult if the receipt write fails — the LLM work is
      // done and the petitioner already paid. Surface the full chain error
      // in logs (the casper-js-sdk error wraps the upstream payload).
      const err = e as { message?: string; sourceErr?: unknown };
      console.warn(
        "[consult] receipt write failed:",
        err.message,
        JSON.stringify(err.sourceErr ?? {}),
      );
    }
  }

  // ─── 6. persist + respond ──────────────────────────────────────────────
  const paidAmount = isDemoAuthorized ? 0.0 : Number(requirements.amount) / 1_000_000;
  await sql`
    INSERT INTO consultations (
      god_id, question, answer, paid_amount_usdc, payment_tx_hash, petitioner,
      receipt_tx_hash, receipt_id_hex
    )
    VALUES (
      ${godId},
      ${question},
      ${answer},
      ${paidAmount},
      ${paidViaX402?.settleTx ?? null},
      ${paidViaX402?.payer ?? null},
      ${receipt?.txHash ?? null},
      ${receipt?.hashHex ?? null}
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
      receipt: receipt
        ? {
            txHash: receipt.txHash,
            hashHex: receipt.hashHex,
            transferId: receipt.transferId,
          }
        : null,
    }),
    { status: 200, headers },
  );
}
