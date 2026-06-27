import { NextResponse } from "next/server";
import {
  COMPARATORS,
  SETTLEMENT_FEEDS,
  settleFromSpec,
  type Comparator,
  type SettlementFeed,
} from "@pantheon/agents";
import {
  approveProposalOnChain,
  confirmProposalCreatedId,
  proposeSettlementOnChain,
  recordOutcomeOnChain,
  settleOnChain,
} from "@pantheon/sdk";
import sql from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

// We claim and finalise one prophecy per cron invocation. A full settle
// pipeline is four on-chain calls (propose → approve → settle →
// record_outcome) plus a ProposalCreated event poll: ~60–120s on testnet.
// Vercel cron fires settle every 15 minutes; that pace is more than enough
// for the daily prophesy load.
//
// One-per-run also lets us hold the row lock for the whole pipeline without
// hitting the 5-minute serverless cap on multi-row batches.
const CLAIM_BATCH = 1;

// A claim older than this is treated as a crashed run — eligible to reclaim.
// Keep in sync with the INTERVAL literal in claimDue().
const STALE_CLAIM_MINUTES = 10;

interface DueProphecy {
  id: number;
  god_id: string;
  on_chain_id: string;
  claim: boolean;
  confidence_bp: number;
  settlement_feed: string;
  settlement_comparator: string;
  settlement_threshold: string;
  propose_tx_hash: string | null;
  approve_tx_hash: string | null;
  settle_tx_hash: string | null;
  reputation_tx_hash: string | null;
  quorum_proposal_id: string | null;
}

interface SettleSummary {
  id: number;
  godId: string;
  onChainId: string;
  truth?: boolean;
  brierBp?: number;
  quorumProposalId?: string;
  proposeTxHash?: string;
  approveTxHash?: string;
  settleTxHash?: string;
  reputationTxHash?: string;
  /** The first step actually executed this run (vs. resumed from DB). */
  firstExecutedStep?: 1 | 2 | 3 | 4;
  error?: string;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const claimed = await claimDue(CLAIM_BATCH);
  const results: SettleSummary[] = [];

  for (const p of claimed) {
    try {
      results.push(await runPipeline(p));
    } catch (e) {
      results.push({
        id: p.id,
        godId: p.god_id,
        onChainId: p.on_chain_id,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Clear the claim regardless of outcome so the next cron run can either
      // resume (steps already persisted to the row are skipped) or retry from
      // a clean slate.
      await sql`
        UPDATE prophecies
        SET processing_started_at = NULL
        WHERE id = ${p.id};
      `;
    }
  }

  return NextResponse.json({
    considered: claimed.length,
    settled: results.filter((r) => !r.error).length,
    results,
  });
}

/**
 * Atomically claim up to `n` due prophecies and stamp processing_started_at.
 * Excludes rows another run is already working on (claim under 10 min old).
 */
async function claimDue(n: number): Promise<DueProphecy[]> {
  return (await sql`
    UPDATE prophecies
    SET processing_started_at = NOW()
    WHERE id IN (
      SELECT id FROM prophecies
      WHERE settled_at IS NULL
        AND settles_at < NOW()
        AND on_chain_id IS NOT NULL
        AND settlement_feed IS NOT NULL
        AND (
          processing_started_at IS NULL
          OR processing_started_at < NOW() - INTERVAL '10 minutes'
        )
      ORDER BY settles_at ASC
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, god_id, on_chain_id, claim, confidence_bp,
              settlement_feed, settlement_comparator, settlement_threshold,
              propose_tx_hash, approve_tx_hash, settle_tx_hash,
              reputation_tx_hash, quorum_proposal_id;
  `) as unknown as DueProphecy[];
}

/**
 * Walk the settlement pipeline, skipping any step whose tx is already
 * persisted on the row. Each step persists its result before the next call so
 * a mid-pipeline crash leaves the row resumable, not stranded.
 */
async function runPipeline(p: DueProphecy): Promise<SettleSummary> {
  const spec = parseSpec(p);
  const reading = await settleFromSpec(spec);
  const brier = brierBp(p.claim, p.confidence_bp, reading.truth);
  // The first step the cron actually executed this run. Undefined means a
  // fresh run from step 1; a number means we resumed from there because
  // earlier steps were already persisted.
  let firstExecutedStep: 1 | 2 | 3 | 4 | undefined;
  const note = (step: 1 | 2 | 3 | 4) => {
    if (firstExecutedStep === undefined) firstExecutedStep = step;
  };

  // 1/4: god proposes the settlement to PriestQuorum (god-signed).
  let proposeTx = p.propose_tx_hash;
  let proposalId = p.quorum_proposal_id;
  if (!proposeTx || !proposalId) {
    note(1);
    proposeTx = await proposeSettlementOnChain({
      godId: p.god_id,
      prophecyId: BigInt(p.on_chain_id),
      truth: reading.truth,
      sourceValue: reading.note,
    });
    const pid = await confirmProposalCreatedId(proposeTx);
    proposalId = pid.toString();
    await sql`
      UPDATE prophecies
      SET propose_tx_hash = ${proposeTx},
          quorum_proposal_id = ${proposalId}
      WHERE id = ${p.id};
    `;
  }

  // 2/4: priest (admin in v1) approves the proposal.
  let approveTx = p.approve_tx_hash;
  if (!approveTx) {
    note(2);
    approveTx = await approveProposalOnChain({
      proposalId: BigInt(proposalId),
      signer: "admin",
    });
    await sql`
      UPDATE prophecies
      SET approve_tx_hash = ${approveTx}
      WHERE id = ${p.id};
    `;
  }

  // 3/4: admin finalises ProphecyRegistry.settle (admin-gated; the quorum
  // signatures above are the multi-party authorisation visible on chain).
  let settleTx = p.settle_tx_hash;
  if (!settleTx) {
    note(3);
    settleTx = await settleOnChain({
      id: BigInt(p.on_chain_id),
      truth: reading.truth,
      sourceValue: reading.note,
    });
    await sql`
      UPDATE prophecies
      SET settle_tx_hash = ${settleTx}
      WHERE id = ${p.id};
    `;
  }

  // 4/4: admin records the outcome on Reputation. The closing UPDATE writes
  // settled_at + brier_bp + reputation_tx_hash atomically — that's the
  // "fully done" signal scoreboard and getGodDetail key off.
  let reputationTx = p.reputation_tx_hash;
  if (!reputationTx) {
    note(4);
    const settledAtMs = Date.now();
    reputationTx = await recordOutcomeOnChain({
      godId: p.god_id,
      brierBp: brier,
      settledAtMs,
    });
    await sql`
      UPDATE prophecies
      SET truth = ${reading.truth},
          brier_bp = ${brier},
          source_value = ${reading.note},
          settled_at = ${new Date(settledAtMs)},
          reputation_tx_hash = ${reputationTx}
      WHERE id = ${p.id};
    `;
  }

  return {
    id: p.id,
    godId: p.god_id,
    onChainId: p.on_chain_id,
    truth: reading.truth,
    brierBp: brier,
    quorumProposalId: proposalId,
    proposeTxHash: proposeTx,
    approveTxHash: approveTx,
    settleTxHash: settleTx,
    reputationTxHash: reputationTx,
    firstExecutedStep,
  };
}

function parseSpec(p: DueProphecy): {
  feed: SettlementFeed;
  comparator: Comparator;
  threshold: number;
} {
  const { settlement_feed, settlement_comparator, settlement_threshold } = p;
  if (!(SETTLEMENT_FEEDS as readonly string[]).includes(settlement_feed)) {
    throw new Error(`prophecy ${p.id} has unknown feed ${settlement_feed}`);
  }
  if (!(COMPARATORS as readonly string[]).includes(settlement_comparator)) {
    throw new Error(
      `prophecy ${p.id} has unknown comparator ${settlement_comparator}`,
    );
  }
  return {
    feed: settlement_feed as SettlementFeed,
    comparator: settlement_comparator as Comparator,
    threshold: Number(settlement_threshold),
  };
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET ?? ""}`;
}

function brierBp(claim: boolean, confidenceBp: number, truth: boolean): number {
  const pTruthBp = claim === truth ? confidenceBp : 10_000 - confidenceBp;
  const diff = 10_000 - pTruthBp;
  return Math.floor((diff * diff) / 10_000);
}
