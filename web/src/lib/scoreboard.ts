import sql from "./db";

export interface GodStats {
  id: "demeter" | "hermes" | "apollo";
  name: string;
  title: string;
  domain: string;
  reputationBp: number; // 0–10000, higher = better
  prophecies_settled: number;
  prophecies_pending: number;
  last_prophecy_at: Date | null;
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

export async function getScoreboard(): Promise<GodStats[]> {
  // Pending count excludes orphans (no on_chain_id) — those can't reach settle
  // until the sweeper backfills them, and inflating the live pending tally
  // misleads viewers.
  //
  // brier_history is ordered by settled_at so we can fold the same EWMA the
  // on-chain Reputation contract computes; otherwise the UI's mean would
  // disagree with cspr.live's view of reputation_bp().
  const rows = (await sql`
    SELECT
      god_id,
      COUNT(*) FILTER (WHERE settled_at IS NOT NULL)::int  AS prophecies_settled,
      COUNT(*) FILTER (WHERE settled_at IS NULL AND on_chain_id IS NOT NULL)::int AS prophecies_pending,
      MAX(published_at) AS last_prophecy_at,
      ARRAY_AGG(brier_bp ORDER BY settled_at)
        FILTER (WHERE settled_at IS NOT NULL AND brier_bp IS NOT NULL) AS brier_history
    FROM prophecies
    GROUP BY god_id;
  `) as unknown as Row[];

  const byId = new Map(rows.map((r) => [r.god_id, r]));
  return (Object.keys(GOD_META) as GodStats["id"][]).map((id) => {
    const r = byId.get(id);
    const ewmaBrier = foldEwma(r?.brier_history ?? []);
    return {
      id,
      ...GOD_META[id],
      reputationBp:
        r && r.prophecies_settled > 0 ? 10_000 - ewmaBrier : 0,
      prophecies_settled: r?.prophecies_settled ?? 0,
      prophecies_pending: r?.prophecies_pending ?? 0,
      last_prophecy_at: r?.last_prophecy_at ?? null,
    };
  });
}
