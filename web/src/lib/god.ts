import sql from "./db";
import { GODS, type GodId } from "@pantheon/agents";
import { getScoreboard, type GodStats } from "./scoreboard";

export interface ProphecyRow {
  id: number;
  on_chain_id: string | null;
  tx_hash: string | null;
  question: string;
  claim: boolean;
  confidence_bp: number;
  reasoning: string;
  published_at: Date;
  settles_at: Date;
  settled_at: Date | null;
  truth: boolean | null;
  brier_bp: number | null;
  source_value: string | null;
  settle_tx_hash: string | null;
  propose_tx_hash: string | null;
  approve_tx_hash: string | null;
  quorum_proposal_id: string | null;
  settlement_feed: string | null;
  settlement_comparator: string | null;
  settlement_threshold: string | null;
}

export interface GodDetail {
  stats: GodStats;
  voice: string;
  allowedFeeds: readonly string[];
  recent: ProphecyRow[];
}

export async function getGodDetail(godId: GodId): Promise<GodDetail | null> {
  if (!(godId in GODS)) return null;

  const board = await getScoreboard();
  const stats = board.find((g) => g.id === godId);
  if (!stats) return null;

  // Cap at 20 — enough to fill a page, not enough to leak the whole table.
  const recent = (await sql`
    SELECT
      id, on_chain_id, tx_hash, question, claim, confidence_bp, reasoning,
      published_at, settles_at, settled_at, truth, brier_bp, source_value,
      settle_tx_hash, propose_tx_hash, approve_tx_hash, quorum_proposal_id,
      settlement_feed, settlement_comparator, settlement_threshold
    FROM prophecies
    WHERE god_id = ${godId}
    ORDER BY published_at DESC
    LIMIT 20;
  `) as unknown as ProphecyRow[];

  return {
    stats,
    voice: GODS[godId].voice,
    allowedFeeds: GODS[godId].allowedFeeds,
    recent,
  };
}

export function prophecyStatus(p: ProphecyRow): {
  label: string;
  tone: "pending" | "fulfilled" | "broken" | "unconfirmed";
} {
  if (p.settled_at && p.truth !== null) {
    return p.truth === p.claim
      ? { label: "Fulfilled", tone: "fulfilled" }
      : { label: "Broken", tone: "broken" };
  }
  if (p.on_chain_id == null) {
    return { label: "Unconfirmed", tone: "unconfirmed" };
  }
  return { label: "Awaiting", tone: "pending" };
}
