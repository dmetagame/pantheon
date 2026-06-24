import { getCasperChainStats } from "./casper";
import { getPythPrices, type PythPrice } from "./pyth";
import type { GodId } from "../types";

function fmtUsd(p: PythPrice, dp = 2): string {
  return `$${p.value.toFixed(dp)} (±$${p.confidence.toFixed(dp)})`;
}

function fmtPct(p: PythPrice, dp = 3): string {
  return `${p.value.toFixed(dp)}% (±${p.confidence.toFixed(dp)}%)`;
}

function ageMinutes(unixSeconds: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSeconds) / 60));
  return `${mins}m ago`;
}

/**
 * Build the live oracle brief that gets injected into the god's prompt.
 * Each god gets data relevant to its domain. Failures fall back to a string
 * acknowledging the gap, so a flaky oracle doesn't kill the prophecy run.
 */
export async function getBrief(godId: GodId): Promise<string> {
  switch (godId) {
    case "demeter":
      return demeterBrief();
    case "hermes":
      return hermesBrief();
    case "apollo":
      return apolloBrief();
  }
}

async function demeterBrief(): Promise<string> {
  const [usdc, chain] = await Promise.allSettled([
    getPythPrices(["USDC_USD"]),
    getCasperChainStats(),
  ]);

  const lines: string[] = [];
  if (usdc.status === "fulfilled") {
    const p = usdc.value.USDC_USD;
    const pegDelta = ((p.value - 1) * 10_000).toFixed(0);
    lines.push(
      `USDC/USD spot: ${fmtUsd(p, 4)}, ${pegDelta} bps from peg, attested ${ageMinutes(p.publishTime)}.`,
    );
  } else {
    lines.push(`USDC peg: oracle unavailable (${usdc.reason}).`);
  }
  if (chain.status === "fulfilled") {
    lines.push(
      `Casper testnet heartbeat: block ${chain.value.blockHeight}, era ${chain.value.eraId}, last block ${chain.value.blockTimestamp}.`,
    );
  } else {
    lines.push(`Casper chain heartbeat: unavailable (${chain.reason}).`);
  }
  return lines.join("\n");
}

async function hermesBrief(): Promise<string> {
  const r = await getPythPrices(["BTC_USD", "ETH_USD"]);
  return [
    `BTC/USD: ${fmtUsd(r.BTC_USD)}, attested ${ageMinutes(r.BTC_USD.publishTime)}.`,
    `ETH/USD: ${fmtUsd(r.ETH_USD)}, attested ${ageMinutes(r.ETH_USD.publishTime)}.`,
  ].join("\n");
}

async function apolloBrief(): Promise<string> {
  const r = await getPythPrices(["US10Y_RATE", "BTC_USD"]);
  return [
    `US 10Y yield: ${fmtPct(r.US10Y_RATE)}, attested ${ageMinutes(r.US10Y_RATE.publishTime)}.`,
    `BTC/USD as macro pulse: ${fmtUsd(r.BTC_USD)}.`,
  ].join("\n");
}
