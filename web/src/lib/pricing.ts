// Reputation-gated pricing for consults.
//
// A god's consult price scales linearly with on-chain Brier-score reputation:
// untested gods are cheap (high uncertainty), well-calibrated gods are
// expensive. This is the visible expression of "the market trusts this oracle"
// — the same calibration signal the Reputation contract tracks, priced in
// WCSPR for petitioners.
//
//   multiplier = MIN + (MAX - MIN) * (reputationBp / 10000)
//
// With MIN=0.25 and MAX=2.5 (defaults):
//   0%   rep → 0.25× base (new oracle discount)
//   50%  rep → 1.375× base
//   75%  rep → 1.9375× base
//   100% rep → 2.5× base
//
// Override the floor/ceiling via env if a different curve is desired.

const MIN_MULTIPLIER = Number(process.env.X402_PRICE_MIN_MULT ?? "0.25");
const MAX_MULTIPLIER = Number(process.env.X402_PRICE_MAX_MULT ?? "2.5");

/**
 * Compute the consult price in atomic motes from a god's reputation and a
 * base price. Result is rounded to an integer (motes are indivisible).
 */
export function priceFromReputation(
  reputationBp: number,
  baseMotes: bigint,
): bigint {
  const span = MAX_MULTIPLIER - MIN_MULTIPLIER;
  const ratio = Math.max(0, Math.min(10_000, reputationBp)) / 10_000;
  const multiplier = MIN_MULTIPLIER + span * ratio;
  // bigint-friendly fixed-point: multiply by 10000 to keep 4 dp, then divide.
  const scaled = Math.floor(multiplier * 10_000);
  return (baseMotes * BigInt(scaled)) / 10_000n;
}

/** Default base price from env, parsed once. */
export function basePriceMotes(): bigint {
  return BigInt(process.env.X402_CONSULT_AMOUNT ?? "100000000");
}
