# Pantheon — Architecture

A calibrated AI-reputation primitive on Casper. Three reference AI agents
("gods") publish daily binary predictions, settle them mechanically against
public oracles, and accumulate a tamper-resistant Brier-score reputation
visible on chain. AI petitioners pay them via x402 with a price linearly
gated by that reputation. When a god is confidently wrong, a fraction of its
treasury is auto-slashed back to the petitioners who paid recently. Every
artifact is verifiable on cspr.live.

## Pipeline at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  AGENTS (signing keypairs, off-chain runtimes)                       │
│  Demeter • Hermes • Apollo (self-custodying gods)                    │
│  Priest (single co-signer for v1, per-god split on roadmap)          │
│  Admin (operator / oracle finaliser)                                 │
│  Petitioner (autonomous agent customer, Claude-driven)               │
└──────────────────┬───────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DAILY PROPHESY (Vercel Cron)                                        │
│  per-god LLM brief + structured-output schema → ProphecyRegistry     │
│  god-signed publish() tx → on_chain_id captured via CES event scan   │
└──────────────────┬───────────────────────────────────────────────────┘
                   │
                   ▼ at settles_at
┌──────────────────────────────────────────────────────────────────────┐
│  SETTLEMENT (Vercel Cron, /api/cron/settle)                          │
│   1. Pyth Hermes attests the price feed                              │
│   2. PriestQuorum.propose(SettleProphecy)   ← god signs              │
│   3. PriestQuorum.approve(proposalId)        ← priest co-signs       │
│   4. ProphecyRegistry.settle()               ← admin finalises       │
│   5. Reputation.record_outcome()             ← admin writes EWMA     │
│   6. if Brier ≥ threshold → CEP18.transfer() ← god refunds petitioner│
└──────────────────┬───────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CONSULT (x402 / WCSPR, /api/consult/[god])                          │
│   • 402 envelope with reputation-gated price                         │
│   • Petitioner signs TransferWithAuthorization (EIP-712)             │
│   • Casper x402 Facilitator verify+settle                            │
│   • LLM consult runs                                                 │
│   • Petitioner signs native receipt (transfer_id = receipt hash)     │
└──────────────────┬───────────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VIEW (UI + MCP + verify endpoint)                                   │
│  / · /god/[id] · /ledger                                             │
│  MCP: list_pantheon, get_god, recent_prophecies, consult_god,        │
│       verify_consult_receipt, pantheon_status                        │
│  /api/verify-receipt: trust-minimised receipt verification           │
└──────────────────────────────────────────────────────────────────────┘
```

## Identities on chain

Every action is signed by one of six distinct Casper accounts:

| Role | Key | Signs |
|---|---|---|
| Demeter | `01c1f05a…` | publish, propose, refund (god-signed CEP18 transfer) |
| Hermes | `017d96d6…` | publish, propose, refund |
| Apollo | `01aea6e8…` | publish, propose, refund |
| Priest | `0116d503…` | approve (quorum co-signer) |
| Admin | `020372ac…` | register_god, settle, record_outcome, set_priesthood |
| Petitioner | `0202cab0…` | x402 TransferWithAuthorization, receipt transfer |

## Contracts

| Contract | Package hash | Purpose |
|---|---|---|
| `ProphecyRegistry` | `d1d0e57c…` | publish + settle binary prophecies, store outcomes |
| `Reputation` | `7e07920b…` | EWMA Brier per god (α = 500bp), miss penalties, read via dictionary query |
| `PriestQuorum` | `cef55e4a…` | god + priest two-of-two propose/approve/execute |

All written in Odra 2.7 / Rust, deployed via the `pantheon_cli` deploy
script in `contracts/cli/`.

The PriestQuorum currently uses its generic `Custom { tag, payload }`
variant to carry the SettleProphecy payload (bytesrepr-encoded
`(prophecy_id, truth, source_value)`). A typed `SettleProphecy` variant
exists in the working tree but the redeploy is blocked on a wasm-toolchain
issue (Rust nightly emits bulk-memory ops the Casper interpreter rejects).
The deployed encoding works identically; only the on-chain schema
self-documentation is downstream.

## Reputation math

```
brier_bp = (10000 - p_truth_bp)² / 10000               (Rust contract math)
accuracy_bp = α · brier_bp + (1−α) · accuracy_bp_prev  (α = 500bp, EWMA)
displayed_reputation_bp = 10000 − accuracy_bp
```

The contract is the source of truth. Our `lib/scoreboard.ts` reads
`accuracy_bp` directly from the Reputation contract's `reputations`
dictionary via `state_get_dictionary_item` and uses it for pricing + display.
The same EWMA is also folded off the local `prophecies` table as a sanity
check; the UI flags any divergence between the two with a `Δ` indicator
("DB ⇄ chain").

## Consult pricing

```
multiplier = MIN + (MAX − MIN) × (reputationBp / 10000)
price_motes = base_price_motes × multiplier
```

Defaults: `MIN = 0.25`, `MAX = 2.5`, base = `0.1 WCSPR`. Newly-deployed gods
get the new-oracle discount; perfectly-calibrated gods cost ~6.7× more.

## Bond pool slashing

When `brier_bp ≥ SLASH_BRIER_BP_THRESHOLD` (default 3000):

```
slash_motes = treasury_motes × SLASH_RATE_BP / 10000   (default 2000bp = 20%)
per_recipient = slash_motes / min(SLASH_RECIPIENTS_MAX, recent_consult_count)
```

The god signs a CEP18 transfer to each of the N most recent petitioners
that haven't already been refunded for this prophecy. Each refund row gets
its `refund_tx_hash` + `refund_amount` + `refund_prophecy_id` persisted so
the UI surfaces the link.

## Consult receipts

```
hash = keccak256(godId | question | answer | settle_tx_hash)
transfer_id = lower 6 bytes of hash, little-endian (JS-safe integer)
```

The petitioner signs a tiny native CSPR transfer to the god (2.5 CSPR — the
Casper testnet native-transfer minimum) with `id = transfer_id`. The chain
records the transfer; anyone with the four inputs can recompute the hash and
look up the matching transfer in cspr.cloud's index. The
`/api/verify-receipt` endpoint and the `verify_consult_receipt` MCP tool
expose this verification without DB access.

## x402

- Facilitator: `https://x402-facilitator.cspr.cloud`
- Network: `casper:casper-test`
- Token: Wrapped CSPR (`3d80df21…`), 9 decimals
- Scheme: `exact`
- Client signing: secp256k1 with `signAndAddAlgorithmBytes` over the
  Casper-domain EIP-712 hash of `TransferWithAuthorization` (per
  `make-software/casper-x402` reference). Source of truth lives in
  `packages/sdk/src/x402.ts`.

## Repository layout

```
pantheon/
├── contracts/                Odra 2.7 / Rust contracts
│   ├── prophecy/             ProphecyRegistry source + tests
│   ├── reputation/           Reputation source + tests
│   ├── priest_quorum/        PriestQuorum source + tests
│   └── cli/                  pantheon_cli deploy + scenario harness
├── packages/
│   ├── sdk/                  Typed Casper bindings (publish/settle/quorum
│   │                         /CEP18/native, x402 signing, reputation read)
│   ├── agents/               LLM god runtimes + Pyth/Casper oracles
│   ├── mcp/                  MCP stdio server (6 tools)
│   └── petitioner/           Autonomous agent CLI
├── web/
│   ├── src/
│   │   ├── app/              Next.js App Router (pages + API)
│   │   ├── lib/              scoreboard, pricing, aggregate, ledger,
│   │   │                     rate-limit, log, consultations, god, db
│   │   └── ...
│   ├── migrations/           SQL schema migrations
│   ├── scripts/              init-gods / init-priest / init-priesthood /
│   │                         init-petitioner / register-gods /
│   │                         backfill-reputation-tx
│   └── vercel.json           Cron schedules (prophesy / settle / sweep)
└── docs/
    ├── ARCHITECTURE.md       (this file)
    └── DEPLOY.md
```

## Crons (Vercel)

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/prophesy/demeter` | `0 9 * * *` | Daily 09:00 UTC LLM prophesy + on-chain publish |
| `/api/cron/prophesy/hermes` | `5 9 * * *` | 09:05 UTC |
| `/api/cron/prophesy/apollo` | `10 9 * * *` | 09:10 UTC |
| `/api/cron/settle` | `*/15 * * * *` | Resolve due prophecies, slash if Brier ≥ 3000bp |
| `/api/cron/sweep` | `*/30 * * * *` | Backfill `on_chain_id` for rows whose publish event we missed |

The settle cron is idempotent across crashes: each of its four chain-call
steps + the closing UPDATE is persisted separately so a re-run from a
mid-pipeline state skips the steps that already landed. See
`web/src/app/api/cron/settle/route.ts`.

## What we explicitly chose NOT to ship in v1

- A separate Temple/treasury contract — each god's Casper account *is* its
  treasury, with WCSPR balance visible directly on chain.
- Worshipper staking / shared-yield Temples — out of scope for the
  primitive demo.
- Open community registration of new gods — the three reference instances
  are hardcoded in `packages/agents/src/registry.ts`. A 4th god needs
  a code change today.
- Cross-chain settlement / mainnet.
- An on-chain exile / governance contract — reputation moves continuously,
  no discrete exile event yet.

## What's on the v2 list

- PriestQuorum redeploy with typed `SettleProphecy` variant (blocked on
  the wasm-toolchain issue noted above).
- Per-god distinct priests (currently one priest co-signs all three).
- Programmatic CSPR → WCSPR wrap (currently a manual cspr.trade UI step).
- Open registration path for new gods.
- Live event tap from cspr.cloud SSE → real-time `/ledger` updates.
