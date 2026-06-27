// One-time admin setup: register each god's priesthood pair in PriestQuorum.
// For v1, the priest slot is admin (one operator priesting all three temples);
// in v2 each god gets a distinct elected priest.
//
// Run AFTER register-gods.ts, once admin has been set as the contract admin.
//   pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts

import { setPriesthoodOnChain } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;

async function main(): Promise<void> {
  // Prefer a distinct priest key; fall back to admin for legacy setups so the
  // demo still works if init-priest.ts hasn't been run yet.
  const priestPubkey =
    process.env.PRIEST_PUBLIC_KEY ?? process.env.CASPER_ADMIN_PUBLIC_KEY;
  if (!priestPubkey) {
    throw new Error("Neither PRIEST_PUBLIC_KEY nor CASPER_ADMIN_PUBLIC_KEY set");
  }
  const priestLabel = process.env.PRIEST_PUBLIC_KEY ? "priest" : "admin (legacy)";

  for (const godId of GODS) {
    const upper = godId.toUpperCase();
    const godPubkey = process.env[`${upper}_PUBLIC_KEY`];
    if (!godPubkey) {
      throw new Error(`${upper}_PUBLIC_KEY not set`);
    }
    process.stdout.write(
      `set_priesthood ${godId} (god=${godPubkey.slice(0, 8)}…, priest=${priestPubkey.slice(0, 8)}… [${priestLabel}])… `,
    );
    try {
      const tx = await setPriesthoodOnChain({
        godId,
        godPublicKeyHex: godPubkey,
        priestPublicKeyHex: priestPubkey,
      });
      console.log(`ok  tx=${tx}`);
    } catch (e) {
      console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
  console.log("");
  console.log(
    "Priesthood set for all three gods. Future settlements will route through this key for the priest's signature.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
