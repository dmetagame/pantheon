import { getFungibleBalance } from "@pantheon/agents";
import { readReputationFromChain } from "@pantheon/sdk";
import sql from "./db";
import { basePriceMotes, priceFromReputation } from "./pricing";
import { log } from "./log";

export interface GodStats {
  id: "demeter" | "hermes" | "apollo";
  name: string;
  title: string;
  domain: string;
  /** Reputation as read from the Reputation contract on chain (canonical). */
  reputationBp: number; // 0–10000, higher = better
  /** Reputation as DB would compute it from its local prophecies table. Used
   *  purely as a sanity check against the chain value. Equal in normal
   *  operation; divergent rows are flagged in the UI. */
  dbReputationBp: number;
  prophecies_settled: number;
  prophecies_pending: number;
  last_prophecy_at: Date | null;
  /** Casper public key (with algorithm prefix). */
  publicKey: string | null;
  /** WCSPR (or configured x402 asset) treasury balance in atomic motes. */
  treasuryMotes: string;
  /** Current consult price in atomic motes (scaled by reputation). */
  consultPriceMotes: string;
}

const GOD_META: Record<GodStats["id"], Pick<GodStats, "name" | "title" | "domain">> = {
  demeter: {
    name: "Demeter",
    title: "Goddess of Harvest",
    domain: "Stablecoin peg & chain health",
  },
  hermes: {
    name: "Hermes",
    title: "Messenger of the Gods",
    domain: "Short-term crypto prices",
  },
  apollo: {
    name: "Apollo",
    title: "God of Prophecy",
    domain: "Macro & real-world assets",
  },
};

interface Row {
  god_id: GodStats["id"];
  prophecies_settled: number;
  prophecies_pending: number;
  last_prophecy_at: Date | null;
  brier_history: number[] | null;
}

// Must match the Reputation contract's alpha (basis points).
// See contracts/reputation/src/reputation.rs::DEFAULT_ALPHA_BP.
const ALPHA_BP = 500;

function foldEwma(samples: number[]): number {
  if (samples.length === 0) return 0;
  let acc = samples[0];
  for (let i = 1; i < samples.length; i++) {
    acc = Math.floor((ALPHA_BP * samples[i] + (10_000 - ALPHA_BP) * acc) / 10_000);
  }
  return acc;
}

/**
 * Single-god reputation lookup. Same EWMA fold as getScoreboard, but only one
 * SQL query and no cspr.cloud calls — cheap enough to run on every consult.
 */
/**
 * Reputation in basis points for a single god, read from the on-chain
 * Reputation contract. Used by the consult-pricing path so the price a
 * petitioner pays scales with the same number cspr.live shows for the god.
 */
export async function getReputationBp(id: GodStats["id"]): Promise<number> {
  return (await fetchChainReputation(id)).reputationBp;
}

function godPublicKey(id: GodStats["id"]): string | null {
  return process.env[`${id.toUpperCase()}_PUBLIC_KEY`] ?? null;
}

async function fetchTreasury(publicKeyHex: string | null): Promise<bigint> {
  const tokenHash = process.env.X402_TOKEN_HASH;
  if (!publicKeyHex || !tokenHash) return 0n;
  try {
    return await getFungibleBalance(publicKeyHex, tokenHash);
  } catch (e) {
    // Don't fail the whole page if the indexer hiccups; treasury just shows 0.
    log.warn("scoreboard.treasury_fetch_failed", {
      publicKey: publicKeyHex,
      error: e instanceof Error ? e.message : String(e),
    });
    return 0n;
  }
}

interface ChainRep {
  reputationBp: number;
  prophecies_settled: number;
}

async function fetchChainReputation(id: GodStats["id"]): Promise<ChainRep> {
  try {
    const r = await readReputationFromChain(id);
    if (!r) return { reputationBp: 0, prophecies_settled: 0 };
    return {
      reputationBp: 10_000 - r.accuracyBp,
      prophecies_settled: r.prophecies_settled,
    };
  } catch (e) {
    log.warn("scoreboard.chain_reputation_fetch_failed", {
      godId: id,
      error: e instanceof Error ? e.message : String(e),
    });
    return { reputationBp: 0, prophecies_settled: 0 };
  }
}

export async function getScoreboard(): Promise<GodStats[]> {
  // Pending count excludes orphans (no on_chain_id) — those can't reach settle
  // until the sweeper backfills them, and inflating the live pending tally
  // misleads viewers.
  //
  // brier_history is ordered by settled_at and filtered to rows that actually
  // had record_outcome land on chain (reputation_tx_hash NOT NULL). Early
  // test settlements that never propagated to the Reputation contract would
  // otherwise inflate the DB EWMA vs. what the chain holds. With this filter
  // the DB fold and the on-chain reputation_bp(godId) agree exactly.
  const rows = (await sql`
    SELECT
      god_id,
      COUNT(*) FILTER (WHERE settled_at IS NOT NULL AND reputation_tx_hash IS NOT NULL)::int AS prophecies_settled,
      COUNT(*) FILTER (WHERE settled_at IS NULL AND on_chain_id IS NOT NULL)::int AS prophecies_pending,
      MAX(published_at) AS last_prophecy_at,
      ARRAY_AGG(brier_bp ORDER BY settled_at)
        FILTER (WHERE settled_at IS NOT NULL AND brier_bp IS NOT NULL AND reputation_tx_hash IS NOT NULL) AS brier_history
    FROM prophecies
    GROUP BY god_id;
  `) as unknown as Row[];

  const byId = new Map(rows.map((r) => [r.god_id, r]));
  const ids = Object.keys(GOD_META) as GodStats["id"][];
  // Fan out to cspr.cloud (treasury) and the node RPC (chain reputation) in
  // parallel so the page render isn't serialised on two round-trips per god.
  const [treasuries, chainReps] = await Promise.all([
    Promise.all(ids.map((id) => fetchTreasury(godPublicKey(id)))),
    Promise.all(ids.map((id) => fetchChainReputation(id))),
  ]);
  const base = basePriceMotes();
  return ids.map((id, i) => {
    const r = byId.get(id);
    const ewmaBrier = foldEwma(r?.brier_history ?? []);
    const dbReputationBp =
      r && r.prophecies_settled > 0 ? 10_000 - ewmaBrier : 0;
    const chain = chainReps[i];
    // Chain is the canonical source for pricing + display. The DB EWMA is
    // tracked separately so the UI can show "off-chain agrees" or flag a
    // divergence when ops state and chain state drift.
    const reputationBp = chain.reputationBp;
    const prophecies_settled = Math.max(
      chain.prophecies_settled,
      r?.prophecies_settled ?? 0,
    );
    return {
      id,
      ...GOD_META[id],
      reputationBp,
      dbReputationBp,
      prophecies_settled,
      prophecies_pending: r?.prophecies_pending ?? 0,
      last_prophecy_at: r?.last_prophecy_at ?? null,
      publicKey: godPublicKey(id),
      treasuryMotes: treasuries[i].toString(),
      consultPriceMotes: priceFromReputation(reputationBp, base).toString(),
    };
  });
}
