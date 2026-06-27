// One-time admin setup: register each god's priesthood pair in PriestQuorum.
// For v1, the priest slot is admin (one operator priesting all three temples);
// in v2 each god gets a distinct elected priest.
//
// Run AFTER register-gods.ts, once admin has been set as the contract admin.
//   pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts

import { setPriesthoodOnChain } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;

async function main(): Promise<void> {
  const adminPubkey = process.env.CASPER_ADMIN_PUBLIC_KEY;
  if (!adminPubkey) {
    throw new Error("CASPER_ADMIN_PUBLIC_KEY not set");
  }
  for (const godId of GODS) {
    const upper = godId.toUpperCase();
    const godPubkey = process.env[`${upper}_PUBLIC_KEY`];
    if (!godPubkey) {
      throw new Error(`${upper}_PUBLIC_KEY not set`);
    }
    process.stdout.write(`set_priesthood ${godId} (god=${godPubkey.slice(0, 8)}…, priest=admin)… `);
    try {
      const tx = await setPriesthoodOnChain({
        godId,
        godPublicKeyHex: godPubkey,
        priestPublicKeyHex: adminPubkey,
      });
      console.log(`ok  tx=${tx}`);
    } catch (e) {
      console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
  console.log("");
  console.log("Priesthood set for all three gods. Settlement quorum is now wired.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
