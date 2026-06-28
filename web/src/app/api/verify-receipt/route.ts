// Trust-minimised consultation verification.
//
// Inputs: godId + question + answer + settleTxHash
// Steps:
//   1. Recompute receipt hash = keccak256(godId | question | answer | settleTx)
//   2. Derive expected transfer-id (lower 6 bytes, little-endian, JS-safe)
//   3. Query cspr.cloud for the god's recent native transfers
//   4. Match by transfer id; report whether found
//
// Anyone with the four inputs can independently verify the consultation
// happened — no DB trust required.

import { NextResponse } from "next/server";
import { GODS } from "@pantheon/agents";
import { consultReceiptHash, receiptHashToTransferId } from "@pantheon/sdk";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CsprCloudTransfer {
  id: number | string;
  amount: string;
  deploy_hash: string;
  initiator_account_hash: string;
  to_account_hash: string;
  timestamp: string;
}

interface CsprCloudTransfersResp {
  data: CsprCloudTransfer[];
  item_count: number;
}

export async function POST(req: Request) {
  // Verification is cheap (no LLM, no chain write) but it does hit
  // cspr.cloud's tx index. 120/min per IP is plenty for any legitimate
  // verifier.
  const { headers: rlHeaders, deny } = enforceRateLimit(req, "verify", {
    capacity: 120,
    windowMs: 60_000,
  });
  if (deny) return deny;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400, headers: rlHeaders },
    );
  }
  const { godId, question, answer, settleTxHash } = (body ?? {}) as {
    godId?: string;
    question?: string;
    answer?: string;
    settleTxHash?: string;
  };
  if (
    !godId ||
    !question ||
    !answer ||
    !settleTxHash ||
    !(godId in GODS)
  ) {
    return NextResponse.json(
      { error: "godId, question, answer, settleTxHash all required" },
      { status: 400, headers: rlHeaders },
    );
  }

  const godPubkey = process.env[`${godId.toUpperCase()}_PUBLIC_KEY`];
  if (!godPubkey) {
    return NextResponse.json(
      { error: `${godId} has no PUBLIC_KEY configured` },
      { status: 500, headers: rlHeaders },
    );
  }

  // 1. recompute
  const hash = consultReceiptHash(godId, question, answer, settleTxHash);
  const transferId = receiptHashToTransferId(hash);
  const hashHex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

  // 2. query cspr.cloud for the god's recent native transfers
  const auth = process.env.CSPR_CLOUD_API_KEY ?? "";
  const base =
    process.env.CSPR_CLOUD_API_URL ?? "https://api.testnet.cspr.cloud";
  const url = `${base}/accounts/${godPubkey}/transfers?page=1&limit=50&order_by=timestamp&order_direction=DESC`;
  const res = await fetch(url, {
    headers: auth ? { Authorization: auth } : {},
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `cspr.cloud ${res.status}: ${await res.text().catch(() => "")}` },
      { status: 502, headers: rlHeaders },
    );
  }
  const data = (await res.json()) as CsprCloudTransfersResp;

  // 3. match
  const target = String(transferId);
  const match = data.data.find(
    (t) => String(t.id) === target,
  );

  return NextResponse.json({
    verified: !!match,
    inputs: { godId, question, answer, settleTxHash },
    expected: {
      receiptHashHex: hashHex,
      transferId: target,
      godAccountKey: `00${godPubkey.slice(2).slice(0, 64) ?? ""}`,
    },
    match: match
      ? {
          deployHash: match.deploy_hash,
          amount: match.amount,
          initiator: match.initiator_account_hash,
          recipient: match.to_account_hash,
          timestamp: match.timestamp,
        }
      : null,
    explanation: match
      ? "Receipt verified. The keccak256 of (godId | question | answer | settleTxHash) maps to the transfer-id of a native CSPR transfer to the god's account — proving the petitioner committed this exact answer on chain."
      : "No matching receipt found among the god's recent 50 transfers. The consultation may not have been receipt-binded, or the inputs don't match what was originally signed.",
  }, { headers: rlHeaders });
}
