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

/**
 * Fetch a fungible-token (CEP18) balance for a Casper account.
 *
 * @param publicKeyHex Account public key (with algorithm prefix).
 * @param contractPackageHash The 64-hex CEP18 contract package hash.
 * @returns Balance in atomic units (motes). Zero if no holding.
 */
export async function getFungibleBalance(
  publicKeyHex: string,
  contractPackageHash: string,
): Promise<bigint> {
  const auth = process.env.CSPR_CLOUD_API_KEY;
  if (!auth) throw new Error("CSPR_CLOUD_API_KEY not set");

  const url = `${DEFAULT_BASE}/accounts/${publicKeyHex}/ft-token-ownership?contract_package_hash=${contractPackageHash}`;
  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`cspr.cloud ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    data: Array<{ balance: string; contract_package_hash: string }>;
  };
  // The endpoint accepts a filter but doesn't always honor it — fold defensively.
  let total = 0n;
  for (const row of body.data) {
    if (
      row.contract_package_hash.toLowerCase() ===
      contractPackageHash.toLowerCase()
    ) {
      total += BigInt(row.balance);
    }
  }
  return total;
}
