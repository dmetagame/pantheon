// Pyth price feeds we consume. The id is the 32-byte feed id (no 0x prefix).
// Source: hermes.pyth.network/v2/price_feeds.
export const PYTH_FEEDS = {
  BTC_USD: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH_USD: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  USDC_USD: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  US10Y_RATE: "9c196541230ba421baa2a499214564312a46bb47fb6b61ef63db2f70d3ce34c1",
} as const;

export type PythFeedId = keyof typeof PYTH_FEEDS;

export interface PythPrice {
  /** Decoded numeric value (price * 10^expo). */
  value: number;
  /** Symmetric one-sigma confidence band on `value`. */
  confidence: number;
  /** Unix seconds when the price was last attested. */
  publishTime: number;
}

const HERMES = "https://hermes.pyth.network";

/**
 * Fetch the latest attested price for one or more Pyth feeds in a single call.
 * Returns a map keyed by the same symbol you passed in.
 */
export async function getPythPrices<K extends PythFeedId>(
  feeds: readonly K[],
): Promise<Record<K, PythPrice>> {
  const params = feeds
    .map((k) => `ids[]=0x${PYTH_FEEDS[k]}`)
    .join("&");
  const url = `${HERMES}/v2/updates/price/latest?${params}&parsed=true`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Pyth ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    parsed: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };

  const out: Partial<Record<K, PythPrice>> = {};
  for (const k of feeds) {
    const want = PYTH_FEEDS[k];
    const row = body.parsed.find((p) => p.id.toLowerCase() === want);
    if (!row) throw new Error(`Pyth feed ${k} (${want}) missing from response`);
    const scale = Math.pow(10, row.price.expo);
    out[k] = {
      value: Number(row.price.price) * scale,
      confidence: Number(row.price.conf) * scale,
      publishTime: row.price.publish_time,
    };
  }
  return out as Record<K, PythPrice>;
}
