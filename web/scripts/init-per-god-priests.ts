// Generate one priest keypair per god so the quorum trail shows three
// genuinely independent priest signers instead of one shared key co-signing
// for all three.
//
// Idempotent — reuses existing PEMs at ~/.pantheon-keys/priest_<god>.pem.
//
// Run:  pnpm exec tsx --env-file=.env.local scripts/init-per-god-priests.ts
//
// After this:
//   1) fund each printed account from https://testnet.cspr.live/tools/faucet
//   2) add the printed env lines to web/.env.local
//   3) re-run scripts/init-priesthood.ts (now reads per-god PRIEST_*_PUBLIC_KEY)

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { generateKey, keyInfoFromPem } from "@pantheon/sdk";

const GODS = ["demeter", "hermes", "apollo"] as const;
const KEYS_DIR = resolve(homedir(), ".pantheon-keys");

interface PriestKey {
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

  const out: PriestKey[] = [];
  for (const godId of GODS) {
    const pemPath = resolve(KEYS_DIR, `priest_${godId}.pem`);
    if (existsSync(pemPath)) {
      const info = keyInfoFromPem(readFileSync(pemPath, "utf8"));
      out.push({ godId, pemPath, ...info, generated: false });
      continue;
    }
    const k = generateKey("Ed25519");
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
  console.log("Pantheon — per-god priest keypairs");
  console.log("==================================");
  for (const k of out) {
    console.log("");
    console.log(`  ${k.godId.toUpperCase()} priest  ${k.generated ? "(new)" : "(exists)"}`);
    console.log(`    pem path     ${k.pemPath}`);
    console.log(`    public key   ${k.publicKeyHex}`);
    console.log(`    account hash ${k.accountHash}`);
  }

  console.log("");
  console.log("Add to web/.env.local:");
  console.log("");
  for (const k of out) {
    const upper = k.godId.toUpperCase();
    console.log(`PRIEST_${upper}_PUBLIC_KEY=${k.publicKeyHex}`);
    console.log(`CASPER_PRIEST_${upper}_SECRET_KEY_PATH=${k.pemPath}`);
  }
  console.log("");
  console.log("Fund each account from the testnet faucet:");
  for (const k of out) {
    console.log(`  https://testnet.cspr.live/tools/faucet?recipient=${k.publicKeyHex}`);
  }
  console.log("");
  console.log("Then re-run:");
  console.log("  pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts");
}

main();
