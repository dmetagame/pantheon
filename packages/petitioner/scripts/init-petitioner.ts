// Generate the demo Petitioner's Casper keypair under ~/.pantheon-keys/petitioner.pem.
// Idempotent — reuses an existing PEM if one is on disk.
//
// Run:  pnpm exec tsx --env-file=../../web/.env.local scripts/init-petitioner.ts
//
// After this:
//   1) fund the printed account from https://testnet.cspr.live/tools/faucet
//   2) add the printed env vars to web/.env.local
//   3) (Tier 1.B) the next round will plug this keypair into the x402 client

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

const KEYS_DIR = resolve(homedir(), ".pantheon-keys");
const PEM_PATH = resolve(KEYS_DIR, "petitioner.pem");

function main(): void {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  let info: { publicKeyHex: string; accountHash: string };
  let generated = false;
  if (existsSync(PEM_PATH)) {
    info = keyInfoFromPem(readFileSync(PEM_PATH, "utf8"));
  } else {
    // Secp256k1 because the x402 Facilitator's signature verifier
    // (casper-eip-712) does ECDSA public-key recovery and only accepts
    // secp256k1 signatures. Ed25519 keys cannot be verified through it.
    const k = generateKey("Secp256k1");
    writeFileSync(PEM_PATH, k.pem, { mode: 0o600 });
    chmodSync(PEM_PATH, 0o600);
    info = { publicKeyHex: k.publicKeyHex, accountHash: k.accountHash };
    generated = true;
  }

  console.log("");
  console.log(`Pantheon — petitioner keypair  ${generated ? "(new)" : "(exists)"}`);
  console.log("==============================");
  console.log(`  pem path     ${PEM_PATH}`);
  console.log(`  public key   ${info.publicKeyHex}`);
  console.log(`  account hash ${info.accountHash}`);
  console.log("");
  console.log("Add to web/.env.local:");
  console.log("");
  console.log(`CASPER_PETITIONER_SECRET_KEY_PATH=${PEM_PATH}`);
  console.log(`PETITIONER_PUBLIC_KEY=${info.publicKeyHex}`);
  console.log("");
  console.log("Fund the account with CSPR from the testnet faucet:");
  console.log(`  https://testnet.cspr.live/tools/faucet?recipient=${info.publicKeyHex}`);
  console.log("");
  console.log("CEP18 token funding will be handled in Tier 1.D once we know which token to use.");
  console.log("");
}

main();
