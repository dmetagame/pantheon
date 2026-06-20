# Deploying Pantheon

## What you need (one-time setup)

| Resource | Where | Notes |
|---|---|---|
| Casper Testnet wallet (admin) | https://cspr.live | Fund with faucet at https://testnet.cspr.live/tools/faucet |
| Casper Testnet wallet (Demeter) | same | Per-god account — the god signs its own prophecies |
| Casper Testnet wallet (Hermes) | same | |
| Casper Testnet wallet (Apollo) | same | |
| Neon Postgres DB | https://console.neon.tech | Free tier, copy `DATABASE_URL` |
| Vercel AI Gateway key | https://vercel.com/ai-gateway | Free; gives access to Gemini + Groq with failover |
| CSPR.cloud API key | https://cspr.cloud | Free; used for testnet RPC + TVL feed |

## Fill `.env.local`

```sh
cp .env.example .env.local
# edit all marked fields
```

## Initialize DB

```sh
cd web
pnpm db:migrate
pnpm db:seed          # optional: seed with fake prophecies so UI has data
```

## Build & deploy the Prophecy contract

```sh
cd contracts
cargo odra build      # → wasm/ProphecyRegistry.wasm

# Deploy via Odra CLI (uses key files from CASPER_*_SECRET_KEY_PATH)
cargo run --bin pantheon_cli -- deploy \
  --node-url $CASPER_NODE_URL \
  --chain-name $CASPER_NETWORK \
  --secret-key $CASPER_ADMIN_SECRET_KEY_PATH
```

After deploy, the CLI prints the contract hash. Add it to `.env.local` as
`PANTHEON_CONTRACT_HASH`.

## Register the gods

Each god has its own funded Casper account that's authorized to publish:

```sh
cargo run --bin pantheon_cli -- call register_god \
  --god-id demeter --publisher $DEMETER_PUBLIC_KEY
# repeat for hermes, apollo
```

## Deploy the web app

```sh
cd web
vercel link
vercel env pull
vercel deploy --prod
```

Vercel reads `vercel.json` and provisions four cron jobs:

| Path | Schedule |
|---|---|
| `/api/cron/prophesy/demeter` | `0 9 * * *` (9:00 UTC daily) |
| `/api/cron/prophesy/hermes` | `5 9 * * *` |
| `/api/cron/prophesy/apollo` | `10 9 * * *` |
| `/api/cron/settle` | `*/15 * * * *` (every 15 minutes) |

Vercel sends each cron call with `Authorization: Bearer $CRON_SECRET` — set
`CRON_SECRET` to any random string in your Vercel env vars.

## Known issues

- **`wasm-opt` missing locally.** Odra warns about it at the end of every
  build. Optimization is purely a size step; the unoptimized WASM deploys
  and runs identically. Install via `apt install binaryen` if you want
  smaller artifacts (~10–30% reduction).
