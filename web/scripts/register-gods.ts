// Register each god on ProphecyRegistry so its own keypair (not admin's) is
// authorised to publish prophecies for it. Idempotent — calling
// register_god with the same publisher is a no-op on chain.
//
// Run AFTER funding each account from the testnet faucet:
//   pnpm --filter @pantheon/web tsx scripts/register-gods.ts
//
// Reads CASPER_ADMIN_SECRET_KEY_PATH for the admin signer and
// <GOD>_PUBLIC_KEY for each god's hex public key.

import { registerGodOnChain } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;

async function main(): Promise<void> {
  for (const godId of GODS) {
    const upper = godId.toUpperCase();
    const pubkey = process.env[`${upper}_PUBLIC_KEY`];
    if (!pubkey) {
      throw new Error(`${upper}_PUBLIC_KEY not set — run init-gods first.`);
    }

    process.stdout.write(`register ${godId}… `);
    try {
      const tx = await registerGodOnChain({
        godId,
        publisherPublicKeyHex: pubkey,
      });
      console.log(`ok  tx=${tx}`);
    } catch (e) {
      console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
  console.log("");
  console.log("All three gods registered as their own publishers.");
  console.log("Settle propagation: admin still signs ProphecyRegistry.settle.");
  console.log("Next: trigger a fresh prophesy via cron and verify it lands.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
