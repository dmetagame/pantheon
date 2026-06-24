// Casper chain heartbeat from cspr.cloud. Used as soil-level context for Demeter.
const DEFAULT_BASE =
  process.env.CSPR_CLOUD_API_URL ?? "https://api.testnet.cspr.cloud";

export interface CasperChainStats {
  /** Latest finalized block height. */
  blockHeight: number;
  /** Latest known era id. */
  eraId: number;
  /** Timestamp of the latest block (ISO 8601). */
  blockTimestamp: string;
}

/**
 * Fetch the most recent block from CSPR.cloud as a low-cost chain heartbeat.
 * Requires `CSPR_CLOUD_API_KEY` in the environment.
 */
export async function getCasperChainStats(): Promise<CasperChainStats> {
  const auth = process.env.CSPR_CLOUD_API_KEY;
  if (!auth) throw new Error("CSPR_CLOUD_API_KEY not set");

  const url = `${DEFAULT_BASE}/blocks?page=1&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`cspr.cloud ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    data: Array<{ block_height: number; era_id: number; timestamp: string }>;
  };
  const row = body.data[0];
  if (!row) throw new Error("cspr.cloud /blocks returned empty data");

  return {
    blockHeight: row.block_height,
    eraId: row.era_id,
    blockTimestamp: row.timestamp,
  };
}
