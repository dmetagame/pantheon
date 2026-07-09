// Trust-minimised consultation verification.
//
// Inputs: godId + question + answer + settleTxHash
// Steps:
//   1. Recompute receipt hash = keccak256(godId | question | answer | settleTx)
//   2. Derive expected transfer-id (lower 6 bytes, little-endian, JS-safe)
//   3. Query cspr.cloud for the god's recent native transfers
//   4. Match by transfer id; report whether found
//
// Anyone with the four inputs can independently verify that the configured
// receipt signer committed to the consultation answer — no DB trust required.

import { NextResponse } from "next/server";
import { GODS } from "@pantheon/agents";
import {
  consultReceiptHash,
  pubkeyToAccountKeyHex,
  receiptHashToTransferId,
} from "@pantheon/sdk";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CASPER_TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const MAX_QUESTION_CHARS = 2_000;
const MAX_ANSWER_CHARS = 20_000;

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
    typeof godId !== "string" ||
    typeof question !== "string" ||
    typeof answer !== "string" ||
    typeof settleTxHash !== "string" ||
    question.length === 0 ||
    answer.length === 0 ||
    !(godId in GODS)
  ) {
    return NextResponse.json(
      { error: "godId, question, answer, settleTxHash all required" },
      { status: 400, headers: rlHeaders },
    );
  }

  const cleanSettleTxHash = settleTxHash.trim();
  if (!CASPER_TX_HASH_RE.test(cleanSettleTxHash)) {
    return NextResponse.json(
      { error: "settleTxHash must be a 64-character Casper transaction hash" },
      { status: 400, headers: rlHeaders },
    );
  }
  if (
    question.length > MAX_QUESTION_CHARS ||
    answer.length > MAX_ANSWER_CHARS
  ) {
    return NextResponse.json(
      {
        error: `question must be <= ${MAX_QUESTION_CHARS} chars and answer <= ${MAX_ANSWER_CHARS} chars`,
      },
      { status: 413, headers: rlHeaders },
    );
  }

  const godPubkey = process.env[`${godId.toUpperCase()}_PUBLIC_KEY`];
  if (!godPubkey) {
    return NextResponse.json(
      { error: `${godId} has no PUBLIC_KEY configured` },
      { status: 500, headers: rlHeaders },
    );
  }
  const godAccountKey = pubkeyToAccountKeyHex(godPubkey);
  const receiptSignerPubkey = process.env.PETITIONER_PUBLIC_KEY;
  const receiptSignerAccountKey = receiptSignerPubkey
    ? pubkeyToAccountKeyHex(receiptSignerPubkey)
    : null;

  // 1. recompute
  const hash = consultReceiptHash(godId, question, answer, cleanSettleTxHash);
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
  const expectedRecipient = normalizeAccountKey(godAccountKey);
  const expectedInitiator = receiptSignerAccountKey
    ? normalizeAccountKey(receiptSignerAccountKey)
    : null;
  const match = data.data.find(
    (t) =>
      String(t.id) === target &&
      normalizeAccountKey(t.to_account_hash) === expectedRecipient &&
      (!expectedInitiator ||
        normalizeAccountKey(t.initiator_account_hash) === expectedInitiator),
  );

  return NextResponse.json({
    verified: !!match,
    inputs: { godId, question, answer, settleTxHash: cleanSettleTxHash },
    expected: {
      receiptHashHex: hashHex,
      transferId: target,
      godAccountKey,
      receiptSignerAccountKey,
    },
    match: match
      ? {
          transactionHash: match.deploy_hash,
          deployHash: match.deploy_hash,
          amount: match.amount,
          initiator: match.initiator_account_hash,
          recipient: match.to_account_hash,
          timestamp: match.timestamp,
        }
      : null,
    explanation: match
      ? receiptSignerAccountKey
        ? "Receipt verified. The keccak256 of (godId | question | answer | settleTxHash) maps to the transfer-id of a native CSPR transfer from the configured receipt signer to the god's account, committing this exact answer on chain."
        : "Receipt verified. The keccak256 of (godId | question | answer | settleTxHash) maps to the transfer-id of a native CSPR transfer to the god's account. Configure PETITIONER_PUBLIC_KEY to also verify the receipt signer account."
      : "No matching receipt found among the god's recent 50 transfers to the expected account. The consultation may not have been receipt-binded, the receipt signer may be misconfigured, or the inputs don't match what was originally signed.",
  }, { headers: rlHeaders });
}

function normalizeAccountKey(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/^account-hash-/, "")
    .replace(/^hash-/, "")
    .replace(/^0x/, "");
  if (clean.length === 66 && clean.startsWith("00")) return clean;
  if (clean.length === 64) return `00${clean}`;
  return clean;
}
