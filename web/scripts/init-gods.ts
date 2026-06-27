// Generate Ed25519 keypairs for each god and write the PEMs to
// ~/.pantheon-keys/<god>.pem alongside the admin key. Idempotent — if a PEM
// already exists for a god, we read it and report its public key.
//
// Run:  pnpm --filter @pantheon/web tsx scripts/init-gods.ts
//
// After this, fund each printed account-hash via the testnet faucet:
//   https://testnet.cspr.live/tools/faucet

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { generateEd25519Key, keyInfoFromPem } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;
const KEYS_DIR = resolve(homedir(), ".pantheon-keys");

interface GodKey {
  godId: (typeof GODS)[number];
  pemPath: string;
  publicKeyHex: string;
  accountHash: string;
  generated: boolean;
}

function main(): void {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  const out: GodKey[] = [];
  for (const godId of GODS) {
    const pemPath = resolve(KEYS_DIR, `${godId}.pem`);
    if (existsSync(pemPath)) {
      const info = keyInfoFromPem(readFileSync(pemPath, "utf8"));
      out.push({ godId, pemPath, ...info, generated: false });
      continue;
    }
    const k = generateEd25519Key();
    writeFileSync(pemPath, k.pem, { mode: 0o600 });
    chmodSync(pemPath, 0o600);
    out.push({
      godId,
      pemPath,
      publicKeyHex: k.publicKeyHex,
      accountHash: k.accountHash,
      generated: true,
    });
  }

  console.log("");
  console.log("Pantheon — god keypairs");
  console.log("=======================");
  for (const k of out) {
    console.log("");
    console.log(`  ${k.godId.toUpperCase()}  ${k.generated ? "(new)" : "(exists)"}`);
    console.log(`    pem path     ${k.pemPath}`);
    console.log(`    public key   ${k.publicKeyHex}`);
    console.log(`    account hash ${k.accountHash}`);
  }

  console.log("");
  console.log("Add to web/.env.local:");
  console.log("");
  for (const k of out) {
    const upper = k.godId.toUpperCase();
    console.log(`CASPER_GOD_${upper}_SECRET_KEY_PATH=${k.pemPath}`);
    console.log(`${upper}_PUBLIC_KEY=${k.publicKeyHex}`);
  }

  console.log("");
  console.log("Fund each account hash from the testnet faucet:");
  console.log("  https://testnet.cspr.live/tools/faucet");
  console.log("");
  console.log("Then run:");
  console.log("  pnpm --filter @pantheon/web tsx scripts/register-gods.ts");
  console.log("");
}

main();
