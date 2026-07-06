import { NextResponse } from "next/server";
import {
  COMPARATORS,
  SETTLEMENT_FEEDS,
  getFungibleBalance,
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
  transferCep18FromGod,
  type SignerName,
} from "@pantheon/sdk";
import sql from "@/lib/db";
import { log } from "@/lib/log";

// Bond pool / slash on broken prophecy.
// Brier ≥ this threshold (in basis points) triggers a refund from the god's
// treasury back to recent petitioners. A Brier of 5000bp means "50% wrong on
// expectation" — the god was confidently incorrect.
const SLASH_BRIER_BP_THRESHOLD = parseInt(
  process.env.SLASH_BRIER_BP_THRESHOLD ?? "3000",
  10,
);
// Fraction of the god's WCSPR treasury to distribute (basis points).
const SLASH_RATE_BP = parseInt(process.env.SLASH_RATE_BP ?? "2000", 10); // 20%
// Up to this many most-recent consultations get a pro-rata share of the
// slash amount.
const SLASH_RECIPIENTS_MAX = parseInt(
  process.env.SLASH_RECIPIENTS_MAX ?? "3",
  10,
);
const SETTLE_PROPOSAL_CONFIRM_TIMEOUT_MS = parseInt(
  process.env.SETTLE_PROPOSAL_CONFIRM_TIMEOUT_MS ?? "240000",
  10,
);

export const runtime = "nodejs";
export const maxDuration = 300;

// We claim and finalise one prophecy per cron invocation. A full settle
// pipeline is four on-chain calls (propose → approve → settle → reputation
// outcome) plus a ProposalCreated event poll: ~60–120s on testnet.
// Vercel cron fires settle every 15 minutes; that pace is more than enough
// for the daily prophesy load.
//
// One-per-run also lets us hold the row lock for the whole pipeline without
// hitting the 5-minute serverless cap on multi-row batches.
const CLAIM_BATCH = 1;

interface DueProphecy {
  id: number;
  god_id: string;
  on_chain_id: string;
  claim: boolean;
  confidence_bp: number;
  settlement_feed: string;
  settlement_comparator: string;
  settlement_threshold: string;
  truth: boolean | null;
  brier_bp: number | null;
  source_value: string | null;
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
  /** Bond pool refunds dispatched when brier ≥ threshold. */
  refunds?: RefundSummary[];
  slashStatus?: SlashStatus;
  slashNote?: string;
  slashError?: string;
  /** The first step actually executed this run (vs. resumed from DB). */
  firstExecutedStep?: 1 | 2 | 3 | 4;
  rateLimited?: boolean;
  retryAfterMinutes?: number;
  error?: string;
}

type SlashStatus =
  | "not_applicable"
  | "processing"
  | "done"
  | "skipped"
  | "failed";

interface SlashCandidate {
  id: number;
  god_id: string;
  brier_bp: number;
}

interface SlashStepSummary {
  id: number;
  godId: string;
  brierBp: number;
  status: SlashStatus;
  refunds: RefundSummary[];
  note?: string;
  error?: string;
}

interface SettlementFacts {
  truth: boolean;
  brierBp: number;
  sourceValue: string;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const claimed = await claimDue(CLAIM_BATCH);
  const results: SettleSummary[] = [];

  for (const p of claimed) {
    let retainClaim = false;
    try {
      results.push(await runPipeline(p));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (isProviderRateLimit(error)) {
        retainClaim = true;
        await pauseDueSettleQueueForRateLimit();
        log.warn("settle.provider_rate_limited", {
          prophecyId: p.id,
          godId: p.god_id,
          onChainId: p.on_chain_id,
          error,
        });
      }
      results.push({
        id: p.id,
        godId: p.god_id,
        onChainId: p.on_chain_id,
        rateLimited: retainClaim || undefined,
        retryAfterMinutes: retainClaim ? 10 : undefined,
        error,
      });
    } finally {
      // Clear the claim regardless of outcome so the next cron run can either
      // resume (steps already persisted to the row are skipped) or retry from
      // a clean slate. Provider 429s are the exception: keep the timestamp as
      // a short queue cooldown so manual retries don't hammer the submit node.
      if (!retainClaim) {
        await sql`
          UPDATE prophecies
          SET processing_started_at = NULL
          WHERE id = ${p.id};
        `;
      }
    }
  }

  const providerRateLimited = results.some((r) => r.rateLimited);
  const slashCandidates = providerRateLimited
    ? []
    : await claimSlashRetries(CLAIM_BATCH);
  const slashRetries: SlashStepSummary[] = [];
  for (const p of slashCandidates) {
    slashRetries.push(await safeRunSlashStep(p.god_id, p.id, p.brier_bp));
  }

  return NextResponse.json({
    considered: claimed.length,
    settled: results.filter((r) => !r.error).length,
    results,
    slashRetries: {
      considered: slashCandidates.length,
      succeeded: slashRetries.filter((r) => r.status !== "failed").length,
      skippedReason: providerRateLimited
        ? "settlement submit provider rate-limited"
        : undefined,
      results: slashRetries,
    },
  });
}

/**
 * Atomically claim up to `n` due prophecies and stamp processing_started_at.
 * Excludes rows another run is already working on, plus rows intentionally
 * paused after provider 429s (claim under 10 min old).
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
        AND settlement_comparator IS NOT NULL
        AND settlement_threshold IS NOT NULL
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
              truth, brier_bp, source_value,
              propose_tx_hash, approve_tx_hash, settle_tx_hash,
              reputation_tx_hash, quorum_proposal_id;
  `) as unknown as DueProphecy[];
}

async function pauseDueSettleQueueForRateLimit(): Promise<void> {
  await sql`
    UPDATE prophecies
    SET processing_started_at = NOW()
    WHERE settled_at IS NULL
      AND settles_at < NOW()
      AND on_chain_id IS NOT NULL
      AND settlement_feed IS NOT NULL
      AND settlement_comparator IS NOT NULL
      AND settlement_threshold IS NOT NULL;
  `;
}

function isProviderRateLimit(error: string): boolean {
  return /\b429\b|too many requests/i.test(error);
}

/**
 * Claim one settled, high-Brier prophecy whose slash failed previously or
 * predates slash-state tracking. This is intentionally separate from the
 * settle queue: a refund outage must not strand future settlement work.
 */
async function claimSlashRetries(n: number): Promise<SlashCandidate[]> {
  return (await sql`
    UPDATE prophecies
    SET slash_status = 'processing',
        slash_attempted_at = NOW(),
        slash_error = NULL
    WHERE id IN (
      SELECT id FROM prophecies
      WHERE settled_at IS NOT NULL
        AND brier_bp IS NOT NULL
        AND brier_bp >= ${SLASH_BRIER_BP_THRESHOLD}
        AND (
          slash_status IS NULL
          OR (
            slash_status IN ('failed', 'processing')
            AND (
              slash_attempted_at IS NULL
              OR slash_attempted_at < NOW() - INTERVAL '30 minutes'
            )
          )
        )
      ORDER BY settled_at ASC
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, god_id, brier_bp;
  `) as unknown as SlashCandidate[];
}

/**
 * Walk the settlement pipeline, skipping any step whose tx is already
 * persisted on the row. Each step persists its result before the next call so
 * a mid-pipeline crash leaves the row resumable, not stranded.
 */
async function runPipeline(p: DueProphecy): Promise<SettleSummary> {
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
  let facts: SettlementFacts;
  if (!proposeTx || !proposalId) {
    note(1);
    const spec = parseSpec(p);
    const reading = await settleFromSpec(spec);
    facts = {
      truth: reading.truth,
      brierBp: brierBp(p.claim, p.confidence_bp, reading.truth),
      sourceValue: reading.note,
    };
    proposeTx = await proposeSettlementOnChain({
      godId: p.god_id,
      prophecyId: BigInt(p.on_chain_id),
      truth: facts.truth,
      sourceValue: facts.sourceValue,
    });
    const pid = await confirmProposalCreatedId(
      proposeTx,
      SETTLE_PROPOSAL_CONFIRM_TIMEOUT_MS,
    );
    proposalId = pid.toString();
    await sql`
      UPDATE prophecies
      SET truth = ${facts.truth},
          brier_bp = ${facts.brierBp},
          source_value = ${facts.sourceValue},
          propose_tx_hash = ${proposeTx},
          quorum_proposal_id = ${proposalId}
      WHERE id = ${p.id};
    `;
  } else {
    facts = factsFromPersistedProposal(p);
  }

  // 2/4: the priest co-signs the proposal. Per-god priests are preferred
  // (signer = priest_<god>) so the quorum trail shows three independent
  // priest accounts across the pantheon. Falls back to the shared "priest"
  // signer when the per-god env vars aren't configured.
  let approveTx = p.approve_tx_hash;
  if (!approveTx) {
    note(2);
    const perGodEnv =
      process.env[`CASPER_PRIEST_${p.god_id.toUpperCase()}_SECRET_KEY_PATH`] ??
      process.env[`CASPER_PRIEST_${p.god_id.toUpperCase()}_SECRET_KEY_PEM`];
    const priestSigner: SignerName = perGodEnv
      ? (`priest_${p.god_id}` as SignerName)
      : "priest";
    approveTx = await approveProposalOnChain({
      proposalId: BigInt(proposalId),
      signer: priestSigner,
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
      truth: facts.truth,
      sourceValue: facts.sourceValue,
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
      prophecyId: BigInt(p.on_chain_id),
      brierBp: facts.brierBp,
      settledAtMs,
    });
    await sql`
      UPDATE prophecies
      SET truth = ${facts.truth},
          brier_bp = ${facts.brierBp},
          source_value = ${facts.sourceValue},
          settled_at = ${new Date(settledAtMs)},
          reputation_tx_hash = ${reputationTx}
      WHERE id = ${p.id};
    `;
  }

  // 5/5: bond pool / slashing. A Brier ≥ threshold means the god was
  // confidently wrong. Slash a fraction of the god's WCSPR treasury and
  // refund it pro-rata to recent petitioners. Failures are persisted with
  // slash_status='failed' so later cron runs can retry without re-settling.
  const slash = await safeRunSlashStep(p.god_id, p.id, facts.brierBp);

  return {
    id: p.id,
    godId: p.god_id,
    onChainId: p.on_chain_id,
    truth: facts.truth,
    brierBp: facts.brierBp,
    quorumProposalId: proposalId,
    proposeTxHash: proposeTx,
    approveTxHash: approveTx,
    settleTxHash: settleTx,
    refunds: slash.refunds,
    slashStatus: slash.status,
    slashNote: slash.note,
    slashError: slash.error,
    reputationTxHash: reputationTx,
    firstExecutedStep,
  };
}

function factsFromPersistedProposal(p: DueProphecy): SettlementFacts {
  if (
    p.truth === null ||
    p.brier_bp === null ||
    p.source_value === null ||
    p.source_value.length === 0
  ) {
    throw new Error(
      `prophecy ${p.id} has quorum proposal ${p.quorum_proposal_id} but no persisted settlement facts`,
    );
  }
  return {
    truth: p.truth,
    brierBp: p.brier_bp,
    sourceValue: p.source_value,
  };
}

async function safeRunSlashStep(
  godId: string,
  prophecyId: number,
  brierBp: number,
): Promise<SlashStepSummary> {
  try {
    return await runSlashStep(godId, prophecyId, brierBp);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      id: prophecyId,
      godId,
      brierBp,
      status: "failed",
      refunds: [],
      error,
    };
  }
}

async function runSlashStep(
  godId: string,
  prophecyId: number,
  brierBp: number,
): Promise<SlashStepSummary> {
  if (brierBp < SLASH_BRIER_BP_THRESHOLD) {
    await sql`
      UPDATE prophecies
      SET slash_status = 'not_applicable',
          slash_attempted_at = NOW(),
          slash_error = NULL
      WHERE id = ${prophecyId};
    `;
    return {
      id: prophecyId,
      godId,
      brierBp,
      status: "not_applicable",
      refunds: [],
    };
  }

  await sql`
    UPDATE prophecies
    SET slash_status = 'processing',
        slash_attempted_at = NOW(),
        slash_error = NULL
    WHERE id = ${prophecyId};
  `;

  try {
    const outcome = await slashAndRefund(godId, prophecyId, brierBp);
    const status: SlashStatus =
      outcome.refunds.length > 0 ? "done" : "skipped";
    await sql`
      UPDATE prophecies
      SET slash_status = ${status},
          slash_error = ${outcome.skippedReason ?? null}
      WHERE id = ${prophecyId};
    `;
    return {
      id: prophecyId,
      godId,
      brierBp,
      status,
      refunds: outcome.refunds,
      note: outcome.skippedReason,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await sql`
      UPDATE prophecies
      SET slash_status = 'failed',
          slash_error = ${error}
      WHERE id = ${prophecyId};
    `;
    log.warn("settle.slash_failed", {
      prophecyId,
      godId,
      brier: brierBp,
      error,
    });
    throw e;
  }
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
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

function brierBp(claim: boolean, confidenceBp: number, truth: boolean): number {
  const pTruthBp = claim === truth ? confidenceBp : 10_000 - confidenceBp;
  const diff = 10_000 - pTruthBp;
  return Math.floor((diff * diff) / 10_000);
}

interface RefundSummary {
  consultationId: number;
  petitionerAccountKeyHex: string;
  amountMotes: string;
  txHash: string;
}

interface SlashOutcome {
  refunds: RefundSummary[];
  skippedReason?: string;
  eligibleCount?: number;
  failedCount?: number;
}

interface RecentConsult {
  id: number;
  petitioner: string;
}

/**
 * Bond pool slashing. Reads the god's current WCSPR balance, computes the
 * slash amount (treasury × SLASH_RATE_BP / 10000), splits it across up to
 * SLASH_RECIPIENTS_MAX most-recent consultations on this god that haven't
 * been refunded yet, and signs a CEP18 transfer from the god to each
 * petitioner. Records refund_tx_hash + amount on each consultation row.
 */
async function slashAndRefund(
  godId: string,
  prophecyId: number,
  brierBp: number,
): Promise<SlashOutcome> {
  const tokenHash = process.env.X402_TOKEN_HASH;
  const godPubkey = process.env[`${godId.toUpperCase()}_PUBLIC_KEY`];
  if (!tokenHash || !godPubkey) {
    throw new Error(
      `slash config missing for ${godId}: X402_TOKEN_HASH and ${godId.toUpperCase()}_PUBLIC_KEY are required`,
    );
  }

  const treasuryMotes = await getFungibleBalance(godPubkey, tokenHash);
  if (treasuryMotes === 0n) {
    return { refunds: [], skippedReason: "god WCSPR treasury is empty" };
  }

  // Find recent consultations on this god that haven't been refunded yet
  // AND have a petitioner address we can refund to.
  const recents = (await sql`
    SELECT id, petitioner
    FROM consultations
    WHERE god_id = ${godId}
      AND payment_tx_hash IS NOT NULL
      AND refund_tx_hash IS NULL
      AND petitioner IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ${SLASH_RECIPIENTS_MAX};
  `) as unknown as RecentConsult[];

  if (recents.length === 0) {
    return {
      refunds: [],
      skippedReason: "no recent paid consultations with refundable petitioner",
      eligibleCount: 0,
    };
  }

  const totalSlashMotes =
    (treasuryMotes * BigInt(SLASH_RATE_BP)) / 10_000n;
  if (totalSlashMotes === 0n) {
    return { refunds: [], skippedReason: "computed slash amount is zero" };
  }

  // Pro-rata even split — simple and demo-friendly.
  const perRecipient = totalSlashMotes / BigInt(recents.length);
  if (perRecipient === 0n) {
    return {
      refunds: [],
      skippedReason: "computed per-recipient refund is zero",
      eligibleCount: recents.length,
    };
  }

  const summaries: RefundSummary[] = [];
  const failures: string[] = [];
  for (const c of recents) {
    try {
      // Petitioner is the 33-byte Key form from the facilitator's settle
      // response (`00<account-hash>`). The CEP18 transfer expects the bare
      // 32-byte account hash; transferCep18FromGod handles the strip.
      const txHash = await transferCep18FromGod({
        signer: godId as SignerName,
        tokenPackageHash: tokenHash,
        recipientAccountKeyHex: c.petitioner,
        amountMotes: perRecipient,
      });
      await sql`
        UPDATE consultations
        SET refund_tx_hash = ${txHash},
            refund_amount = ${perRecipient.toString()},
            refund_prophecy_id = ${prophecyId}
        WHERE id = ${c.id};
      `;
      summaries.push({
        consultationId: c.id,
        petitionerAccountKeyHex: c.petitioner,
        amountMotes: perRecipient.toString(),
        txHash,
      });
      log.info("slash.refund_dispatched", {
        godId,
        prophecyId,
        consultId: c.id,
        amountMotes: perRecipient.toString(),
        brier: brierBp,
        txHash,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failures.push(error);
      log.warn("slash.refund_failed", {
        godId,
        prophecyId,
        consultId: c.id,
        error,
      });
    }
  }
  if (summaries.length === 0 && failures.length > 0) {
    throw new Error(
      `all slash refund transfers failed (${failures.length}/${recents.length}): ${failures[0]}`,
    );
  }
  if (failures.length > 0) {
    log.warn("slash.partial_refund_failed", {
      godId,
      prophecyId,
      dispatched: summaries.length,
      failed: failures.length,
      brier: brierBp,
    });
  }
  return {
    refunds: summaries,
    eligibleCount: recents.length,
    failedCount: failures.length,
  };
}
