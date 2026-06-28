# Deploying Pantheon

## What you need

| Resource | Where | Notes |
|---|---|---|
| Casper Testnet | https://testnet.cspr.live/tools/faucet | Faucet ~1000 CSPR per request |
| Cspr.cloud API key | https://cspr.cloud | Free testnet tier — used for RPC, balance reads, transfer index, x402 facilitator auth |
| Neon Postgres | https://console.neon.tech | Free tier; copy the pooled `DATABASE_URL` |
| Vercel AI Gateway | https://vercel.com/ai-gateway | Free — backs Gemini + Anthropic with failover |
| WCSPR on cspr.trade | https://testnet.cspr.trade | Manual wrap CSPR → WCSPR for the petitioner (programmatic wrap is on the v2 roadmap) |

## 1. Clone + install

```sh
git clone https://github.com/<you>/pantheon
cd pantheon
pnpm install
```

## 2. Configure env

```sh
cp web/.env.example web/.env.local
```

Fill in the marked fields. Required:

- `AI_GATEWAY_API_KEY` — Vercel AI Gateway
- `CSPR_CLOUD_API_KEY` — cspr.cloud testnet
- `DATABASE_URL` — Neon Postgres (pooled)
- `CASPER_ADMIN_PUBLIC_KEY` / `CASPER_ADMIN_SECRET_KEY_PATH` — admin key
- `CRON_SECRET` — random hex via `openssl rand -hex 32`
- `CONSULT_DEMO_SECRET` — random hex (fallback auth on the consult endpoint
  for ops testing)

## 3. Generate identities (one-time)

```sh
cd web
pnpm exec tsx scripts/init-gods.ts          # 3 god keypairs
pnpm exec tsx scripts/init-priest.ts        # 1 priest keypair
pnpm exec tsx scripts/init-petitioner.ts    # 1 petitioner (secp256k1!)
```

Each script writes a PEM to `~/.pantheon-keys/<name>.pem` and prints the
public key plus the env lines to paste into `web/.env.local`. Petitioner is
**secp256k1** specifically — the x402 facilitator's verifier uses
secp256k1 ECDSA recovery and won't accept Ed25519 signatures.

## 4. Fund accounts

Each printed public key needs CSPR from the testnet faucet. The petitioner
also needs **WCSPR** (manual wrap on cspr.trade — see "Funding the
petitioner" below).

## 5. Apply DB migrations

```sh
cd web
pnpm exec tsx --env-file=.env.local scripts/migrate.ts
```

## 6. Build + deploy the contracts (one-time, or after source changes)

Casper's 2.x WASM interpreter accepts only MVP-shape wasm — no
`bulk-memory`, no sign-ext. The Odra contracts build cleanly against
`wasm32-unknown-unknown` through `cargo odra build` thanks to the
rustflags in `contracts/.cargo/config.toml`. `wrap_cspr` (the session
WASM that calls casper-contract directly) needs the stricter
`wasm32v1-none` target plus `build-std`, exposed via the `wasm-build`
cargo alias.

One-time:

```sh
rustup install nightly-2026-01-01
rustup target add wasm32v1-none --toolchain nightly-2026-01-01
rustup component add rust-src --toolchain nightly-2026-01-01
```

Build:

```sh
cd contracts
cargo +nightly-2026-01-01 odra build \
  -c "ProphecyRegistry Reputation PriestQuorum"
cargo +nightly-2026-01-01 wasm-build -p wrap_cspr --bin wrap_cspr
cp target/wasm32v1-none/release/wrap_cspr.wasm wasm/WrapCspr.wasm
wasm-strip wasm/*.wasm
```

Verify MVP-shape (optional sanity check using
[wabt](https://github.com/WebAssembly/wabt)):

```sh
wasm-validate \
  --disable-bulk-memory --disable-sign-extension --disable-multi-value \
  --disable-reference-types --disable-saturating-float-to-int \
  --disable-mutable-globals \
  wasm/PriestQuorum.wasm wasm/WrapCspr.wasm
```

Deploy via the CLI binary in `cli/`:

```sh
# Run a local proxy that injects the cspr.cloud auth header:
node scripts/cspr-proxy.mjs &

./target/release/pantheon_cli deploy --deploy-mode default
```

After deploy the CLI prints each package hash. Paste them into
`web/.env.local`:

- `PROPHECY_REGISTRY_HASH`
- `REPUTATION_CONTRACT_HASH`
- `REPUTATION_CONTRACT_VERSION_HASH` — also needed for the dictionary read
  (latest contract version hash, not the package hash)
- `PRIEST_QUORUM_HASH`

> ⚠️ The PriestQuorum contract exposes a typed `propose_settle(god_id,
> prophecy_id, truth, source_value)` entry point (with the matching
> `ProposalKind::SettleProphecy` variant) — `packages/sdk` calls that
> entry, not the generic `propose` with a Custom-variant payload.
> Redeployment is required after pulling source changes.

## 7. Register on-chain identities

```sh
cd web
pnpm exec tsx --env-file=.env.local scripts/register-gods.ts
pnpm exec tsx --env-file=.env.local scripts/init-priesthood.ts
```

`register-gods` swaps each god's registered publisher from admin to its own
key. `init-priesthood` calls `PriestQuorum.set_priesthood` for each god
with the priest key.

## 8. Local development

```sh
# Web (Next.js on :3030):
cd web
pnpm dev

# Petitioner CLI (separate terminal):
cd packages/petitioner
PETITIONER_X402=1 pnpm petition "Will USDC stay above 0.999 next hour?"
```

## 9. Deploy to Vercel

```sh
cd web
vercel link
vercel env pull           # syncs env from Vercel UI
vercel deploy --prod
```

Set the env vars in the Vercel UI. **Use the _PEM_ env var paths in
production** (Vercel's filesystem is read-only):

- `CASPER_ADMIN_SECRET_KEY_PEM` (paste full PEM, escape newlines as `\n`)
- `CASPER_PRIEST_SECRET_KEY_PEM`
- `CASPER_GOD_DEMETER_SECRET_KEY_PEM`
- `CASPER_GOD_HERMES_SECRET_KEY_PEM`
- `CASPER_GOD_APOLLO_SECRET_KEY_PEM`
- `CASPER_PETITIONER_SECRET_KEY_PEM`

Vercel reads `vercel.json` and provisions the five cron jobs. Each cron call
arrives with `Authorization: Bearer $CRON_SECRET`.

## Funding the petitioner

The x402 facilitator currently settles in WCSPR. The petitioner has its own
keypair and account hash but starts with no WCSPR. Two paths to fund it:

1. **Manual (testnet only).** Import the petitioner's PEM into a Casper
   Wallet browser extension, connect to `testnet.cspr.trade`, and wrap some
   of the petitioner's CSPR → WCSPR via the cspr.trade UI. Done once;
   petitioner can do hundreds of consults from a small bag.
2. **Programmatic.** `contracts/wrap_cspr` is a session WASM that creates
   a purse, transfers `amount` motes, and calls `WCSPR.deposit` in one
   deploy. Build with the steps in §6, then deploy as a session with
   `wcspr_package_hash` + `amount` runtime args from the petitioner.

## Rate limits + structured logs

Public read+write routes are rate-limited per IP (60/min on
`/api/scoreboard` + `/api/status`, 20/min on `/api/consult/[god]`, 120/min
on `/api/verify-receipt`). Crossing the limit returns 429 with
`RateLimit-*` and `Retry-After` headers.

All log lines from production paths emit one JSON-line per event so
Vercel's log search has structured fields. Set
`PANTHEON_PRETTY_LOGS=1` in local dev for human-readable output.

## CI

`.github/workflows/typecheck.yml` runs `pnpm -r typecheck` on every push
and PR. `.github/workflows/contracts.yml` runs `cargo test --release`
when `contracts/` changes.

## Known issues

- `wasm-opt` warnings during `cargo build` of contracts are non-fatal;
  optimization is a size step. Install `binaryen` for ~30% smaller
  artifacts.
- `node` v22 required (specified in root `package.json`'s `engines`).
- Petitioner CLI's first cspr.cloud query after a long idle can stall
  during the cron-proxy's TLS handshake; retry once if it times out.
