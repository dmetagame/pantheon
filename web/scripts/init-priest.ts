// Generate the Pantheon priest's keypair. v1 uses a single priest across all
// three gods; v2 would split this into per-god elected priests. Idempotent —
// if a PEM already exists at ~/.pantheon-keys/priest.pem we reuse it.
//
// Run:  pnpm exec tsx --env-file=.env.local scripts/init-priest.ts
//
// After this:
//   1) fund the printed account from https://testnet.cspr.live/tools/faucet
//   2) add the printed env vars to web/.env.local
//   3) re-run scripts/init-priesthood.ts so set_priesthood points to this key

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { generateEd25519Key, keyInfoFromPem } from "@pantheon/sdk";

const KEYS_DIR = resolve(homedir(), ".pantheon-keys");
const PEM_PATH = resolve(KEYS_DIR, "priest.pem");

function main(): void {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  let info: { publicKeyHex: string; accountHash: string };
  let generated = false;
  if (existsSync(PEM_PATH)) {
    info = keyInfoFromPem(readFileSync(PEM_PATH, "utf8"));
  } else {
    const k = generateEd25519Key();
    writeFileSync(PEM_PATH, k.pem, { mode: 0o600 });
    chmodSync(PEM_PATH, 0o600);
    info = { publicKeyHex: k.publicKeyHex, accountHash: k.accountHash };
    generated = true;
  }

  console.log("");
  console.log(`Pantheon — priest keypair  ${generated ? "(new)" : "(exists)"}`);
  console.log("==========================");
  console.log(`  pem path     ${PEM_PATH}`);
  console.log(`  public key   ${info.publicKeyHex}`);
  console.log(`  account hash ${info.accountHash}`);
  console.log("");
  console.log("Add to web/.env.local:");
  console.log("");
  console.log(`CASPER_PRIEST_SECRET_KEY_PATH=${PEM_PATH}`);
  console.log(`PRIEST_PUBLIC_KEY=${info.publicKeyHex}`);
  console.log("");
  console.log("Fund the account from the testnet faucet:");
  console.log(`  https://testnet.cspr.live/tools/faucet?recipient=${info.publicKeyHex}`);
  console.log("");
  console.log("Then re-run:");
  console.log("  pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts");
  console.log("");
}

main();
