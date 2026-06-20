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
    domain: "Casper DeFi yields & TVL",
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
  mean_brier_bp: number | null;
  last_prophecy_at: Date | null;
}

export async function getScoreboard(): Promise<GodStats[]> {
  const rows = (await sql`
    SELECT
      god_id,
      COUNT(*) FILTER (WHERE settled_at IS NOT NULL)::int  AS prophecies_settled,
      COUNT(*) FILTER (WHERE settled_at IS NULL)::int      AS prophecies_pending,
      AVG(brier_bp) FILTER (WHERE settled_at IS NOT NULL)::int AS mean_brier_bp,
      MAX(published_at) AS last_prophecy_at
    FROM prophecies
    GROUP BY god_id;
  `) as unknown as Row[];

  const byId = new Map(rows.map((r) => [r.god_id, r]));
  return (Object.keys(GOD_META) as GodStats["id"][]).map((id) => {
    const r = byId.get(id);
    const mean = r?.mean_brier_bp ?? 0;
    return {
      id,
      ...GOD_META[id],
      reputationBp: r && r.prophecies_settled > 0 ? 10_000 - mean : 0,
      prophecies_settled: r?.prophecies_settled ?? 0,
      prophecies_pending: r?.prophecies_pending ?? 0,
      last_prophecy_at: r?.last_prophecy_at ?? null,
    };
  });
}
