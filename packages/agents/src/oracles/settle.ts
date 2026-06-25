import { getPythPrices } from "./pyth";
import type { Comparator, SettlementSpec } from "../types";

export interface SettlementResult {
  /** Did `feedValue <comparator> threshold` evaluate to true? */
  truth: boolean;
  /** Numeric reading we used. */
  feedValue: number;
  /** Human-readable note for on-chain `source_value` and the DB. */
  note: string;
}

function compare(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
}

/**
 * Read the spec's feed via Pyth and evaluate the comparator. The boolean
 * we return is what gets sent to ProphecyRegistry.settle as `truth`.
 */
export async function settleFromSpec(
  spec: SettlementSpec,
): Promise<SettlementResult> {
  const prices = await getPythPrices([spec.feed]);
  const p = prices[spec.feed];
  const truth = compare(p.value, spec.comparator, spec.threshold);
  const note = `${spec.feed}=${p.value.toFixed(6)} ${spec.comparator} ${spec.threshold} → ${truth} @ ${new Date(p.publishTime * 1000).toISOString()}`;
  return { truth, feedValue: p.value, note };
}
