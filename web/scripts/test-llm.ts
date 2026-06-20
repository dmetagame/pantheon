/**
 * Smoke test: exercises prophesy() + consult() end-to-end via AI Gateway.
 *
 *   pnpm tsx --env-file=.env.local scripts/test-llm.ts
 */
import { prophesy, consult } from "@pantheon/agents";

async function run() {
  console.log("\n▸ Demeter prophesies...");
  const p = await prophesy(
    "demeter",
    "Casper DeFi TVL is $42M, +3% over 24h. Largest pool USDC-CSPR at $8.2M. Stablecoin yields 4-9% APY.",
  );
  console.log(JSON.stringify(p, null, 2));

  console.log("\n▸ Hermes is consulted...");
  const answer = await consult(
    "hermes",
    "What's your read on BTC over the next 48 hours?",
  );
  console.log(answer);

  console.log("\n✓ Both gods spoke.");
}

run().catch((err) => {
  console.error("\n💀", err);
  process.exit(1);
});
