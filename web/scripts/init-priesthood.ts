// Admin setup: register each god's priesthood pair in PriestQuorum.
//
// Resolution order for each god's priest:
//   1. PRIEST_<GOD>_PUBLIC_KEY (per-god priest, recommended)
//   2. PRIEST_PUBLIC_KEY (shared priest, legacy)
//   3. CASPER_ADMIN_PUBLIC_KEY (legacy-legacy)
//
// Run AFTER register-gods.ts:
//   pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts

import { setPriesthoodOnChain } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;

interface Resolved {
  priestPubkey: string;
  source: string;
}

function resolvePriest(godId: string): Resolved {
  const upper = godId.toUpperCase();
  const perGod = process.env[`PRIEST_${upper}_PUBLIC_KEY`];
  if (perGod) return { priestPubkey: perGod, source: `priest_${godId}` };
  const shared = process.env.PRIEST_PUBLIC_KEY;
  if (shared) return { priestPubkey: shared, source: "shared priest" };
  const admin = process.env.CASPER_ADMIN_PUBLIC_KEY;
  if (admin) return { priestPubkey: admin, source: "admin (legacy)" };
  throw new Error(
    `No priest configured for ${godId}: set PRIEST_${upper}_PUBLIC_KEY (recommended) or PRIEST_PUBLIC_KEY or CASPER_ADMIN_PUBLIC_KEY.`,
  );
}

async function main(): Promise<void> {
  for (const godId of GODS) {
    const upper = godId.toUpperCase();
    const godPubkey = process.env[`${upper}_PUBLIC_KEY`];
    if (!godPubkey) {
      throw new Error(`${upper}_PUBLIC_KEY not set`);
    }
    const { priestPubkey, source } = resolvePriest(godId);
    process.stdout.write(
      `set_priesthood ${godId} (god=${godPubkey.slice(0, 8)}…, priest=${priestPubkey.slice(0, 8)}… [${source}])… `,
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
    "Priesthood set for all three gods. Settle cron picks the matching priest per god.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
