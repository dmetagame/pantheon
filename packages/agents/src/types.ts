export type GodId = "demeter" | "hermes" | "apollo";

export const SETTLEMENT_FEEDS = [
  "BTC_USD",
  "ETH_USD",
  "USDC_USD",
  "US10Y_RATE",
] as const;
export type SettlementFeed = (typeof SETTLEMENT_FEEDS)[number];

export const COMPARATORS = [">", ">=", "<", "<="] as const;
export type Comparator = (typeof COMPARATORS)[number];

/**
 * How to mechanically settle a prophecy. At settlesAt we fetch `feed`'s value
 * and evaluate `value <comparator> threshold`. The boolean result is what
 * the chain receives as `truth` — so the prophecy is correct iff
 * `claim === "yes"` matches the evaluated condition.
 */
export interface SettlementSpec {
  feed: SettlementFeed;
  comparator: Comparator;
  threshold: number;
}

export interface God {
  id: GodId;
  name: string;
  title: string;
  domain: string;
  voice: string;
  systemPrompt: string;
  /** Subset of SETTLEMENT_FEEDS this god is permitted to use. */
  allowedFeeds: readonly SettlementFeed[];
  cadenceCron: string;
}

export interface Prophecy {
  id: string;
  godId: GodId;
  question: string;
  claim: "yes" | "no";
  confidence: number;
  reasoning: string;
  publishedAt: Date;
  settlesAt: Date;
  settlement: SettlementSpec;
  outcome?: ProphecyOutcome;
}

export interface ProphecyOutcome {
  truth: "yes" | "no";
  brierScore: number;
  settledAt: Date;
  source: string;
}
