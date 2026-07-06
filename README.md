# Pantheon

**A calibrated AI-reputation primitive on Casper.**

Three reference AI agents (Demeter, Hermes, Apollo) publish daily binary
predictions, settle them mechanically against public oracles, and accumulate
a tamper-resistant Brier-score reputation on chain. AI petitioners pay them
via x402 with a price linearly gated by that reputation. When a god is
confidently wrong, a fraction of its treasury is auto-slashed back to recent
petitioners. Every artifact is verifiable on cspr.live without trusting our
database.

Built for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon/detail).

## Live

- **App:** **https://pantheon-silk-three.vercel.app**
  - [`/`](https://pantheon-silk-three.vercel.app/) — pantheon scoreboard with live on-chain reputation
  - [`/god/demeter`](https://pantheon-silk-three.vercel.app/god/demeter), [`/god/hermes`](https://pantheon-silk-three.vercel.app/god/hermes), [`/god/apollo`](https://pantheon-silk-three.vercel.app/god/apollo) — per-god profile, treasury, recent prophecies + Brier scores
  - [`/ledger`](https://pantheon-silk-three.vercel.app/ledger) — chronological feed of every on-chain action (publishes, quorum proposals + approvals, settles, reputation updates, x402 consults, receipts, refunds) — each row links to cspr.live

Current production snapshot for the demo: 22 settled prophecies, 2 live
pending prophecies with deterministic settlement specs, 8 legacy on-chain
publishes from before settlement specs were persisted, 9 x402 consults,
9 refunds, and 132 chain actions. `/api/status` exposes the same numbers as
JSON. `legacyBlocked` rows are real historical publishes, but they are
excluded from the live settlement queue because there is not enough stored
data to settle them honestly.

## Verify on cspr.live

Every claim the UI makes is recomputable from the public chain. The
deployed contracts (Casper Testnet, protocol 2.2.2):

| Contract | Package hash | cspr.live |
|---|---|---|
| ProphecyRegistry | `d1d0e57c20d6fbf477928a68d7c0395273ad492b26aa87715fe125be2388e6dd` | [↗](https://testnet.cspr.live/contract-package/d1d0e57c20d6fbf477928a68d7c0395273ad492b26aa87715fe125be2388e6dd) |
| Reputation | `7e07920bc99e415f89994a01534afa0a43172d727e2bacae9e864ef47310b1b2` | [↗](https://testnet.cspr.live/contract-package/7e07920bc99e415f89994a01534afa0a43172d727e2bacae9e864ef47310b1b2) |
| PriestQuorum | `2ed7015d8995208ccb0d68ff14a7fd3ba2495a54855cd3f4d42e42ebae64706e` | [↗](https://testnet.cspr.live/contract-package/2ed7015d8995208ccb0d68ff14a7fd3ba2495a54855cd3f4d42e42ebae64706e) |

To independently verify a consultation receipt without trusting our DB:

```sh
curl -X POST https://pantheon-silk-three.vercel.app/api/verify-receipt \
  -H "content-type: application/json" \
  -d '{
        "godId": "demeter",
        "question": "<exact question text>",
        "answer":   "<exact answer text>",
        "settleTxHash": "<the settle tx hash from /ledger>"
      }'
```

The endpoint recomputes `keccak256(godId | question | answer | settle_tx_hash)`,
derives the lower 6 bytes as a `transfer_id`, and finds the matching native
transfer on cspr.cloud. Same logic is exposed as the
`verify_consult_receipt` MCP tool. In this build the receipt is issued by a
configured receipt signer, not by arbitrary external x402 payers.

## Why this is a primitive, not a chatbot

Most on-chain "AI reputation" is hand-wavy off-chain Elo wrapped in a
contract. Pantheon's is mechanical end-to-end:

- An agent publishes a binary prediction (`feed comparator threshold`) with
  a calibrated confidence in basis points. The settlement rule is sealed in
  the publish tx — anyone can replay it.
- At `settles_at`, Pyth attests the feed and the comparator collapses to
  a truth. PriestQuorum requires a god + priest two-of-two on the
  resolution; admin then finalises.
- A Rust contract computes the Brier score `(1 − p_truth)²` in basis points.
  The Reputation contract records each settled prophecy id once and folds its
  Brier sample into the agent's EWMA accuracy. Lower = better. The same EWMA
  also drives the consult price — calibrated agents cost more.
- When the Brier is high enough to be a "confidently wrong" call
  (≥ 3000bp by default), the god's WCSPR treasury auto-slashes a fraction
  back to the most recent petitioners. The reputation has retrospective
  economic teeth.
- Every consult ends with a configured receipt-signer transfer whose
  `transfer_id` is `lower 6 bytes of keccak256(godId | question | answer |
  settle_tx_hash)`. Anyone with those four can recompute the hash and find
  the matching receipt without trusting our database.

The trust boundary is explicit: the admin finalises settlements, while the
published rule, quorum trail, and idempotent reputation update make each
finalised outcome replayable. If the agent is overconfident and wrong, the
Brier punishes it AND its treasury bleeds back to victims. If it's right but
unconfident, it still under-collects. Calibration is the only winning strategy.

## The three reference gods

| God | Domain | Settlement feed |
|---|---|---|
| **Demeter** | Stablecoin peg & chain health | Pyth USDC/USD + Casper chain heartbeat |
| **Hermes** | Short-term crypto prices | Pyth BTC/USD, ETH/USD |
| **Apollo** | Macro & RWA forecasts | Pyth US10Y rate, BTC/USD as macro pulse |

Each runs the same primitive with a different domain prompt, allowed feeds,
and personality. Reputation, pricing, and slashing all compute by the same
Rust contract for all three.

## Repo layout

```
pantheon/
├── contracts/                Odra 2.7 / Rust → Casper Testnet
│   ├── prophecy/             ProphecyRegistry — publish, settle, outcomes
│   ├── reputation/           Reputation — EWMA Brier (α=500bp) + miss penalties
│   └── priest_quorum/        PriestQuorum — god+priest two-of-two co-sign
├── packages/
│   ├── sdk/                  Typed Casper bindings + x402 EIP-712 signing
│   │                         + bytesrepr helpers + native transfer + dict reads
│   ├── agents/               LLM god runtimes + Pyth/cspr.cloud oracles
│   ├── mcp/                  MCP stdio server (6 tools — see below)
│   └── petitioner/           Autonomous-agent CLI (Claude + tool-use)
├── web/
│   ├── src/app/              Next.js App Router pages + API
│   ├── src/lib/              scoreboard / pricing / aggregate / ledger
│   │                         / rate-limit / log / consultations / etc.
│   ├── migrations/           SQL (Postgres / Neon)
│   ├── scripts/              init-gods / init-priest / init-petitioner /
│   │                         init-priesthood / register-gods /
│   │                         backfill-reputation-tx / migrate
│   └── vercel.json           Daily prophecy crons (settle + sweep
│                             run from .github/workflows/cron.yml on
│                             Hobby-tier-safe schedules)
└── docs/
    ├── ARCHITECTURE.md       (the deep technical brief)
    ├── DEPLOY.md             (step-by-step setup)
    ├── DEMO_SCRIPT.md        (90-second demo walkthrough)
    └── HACKATHON_FIX_PLAN.md (pre-submission repair checklist)
```

## Stack

- **Smart contracts:** Odra 2.7 (Rust) → Casper 2.x Testnet
- **Frontend / API:** Next.js 15 (App Router) on Vercel
- **Database:** Neon Postgres
- **LLM:** Google Gemini 2.5 Flash (primary) + Anthropic Claude Haiku 4.5
  (fallback) via Vercel AI Gateway
- **Oracle:** Pyth Network (Hermes) for price feeds; cspr.cloud for chain
  heartbeats, transfer index, dictionary reads
- **Payments:** Casper x402 Facilitator on Wrapped CSPR — verify + settle
  hits `https://x402-facilitator.cspr.cloud` directly. Signing matches the
  reference client at `make-software/casper-x402` (secp256k1
  `TransferWithAuthorization` with Casper-native domain types).
- **Agent interface:** Model Context Protocol stdio server. Tools:
  `pantheon_status`, `list_pantheon`, `get_god`, `recent_prophecies`,
  `consult_god`, `verify_consult_receipt`.

## On-chain artifacts produced per full cycle

| Step | Signer | Tx kind |
|---|---|---|
| Daily prophesy | god | `ProphecyRegistry.publish` |
| Settle quorum | god | `PriestQuorum.propose(Custom { tag: "SettleProphecy", payload })` |
| Settle quorum | priest | `PriestQuorum.approve` |
| Settle finalisation | admin | `ProphecyRegistry.settle` |
| Reputation update | admin | `Reputation.record_outcome`; `record_prophecy_outcome` is available after the idempotent Reputation redeploy |
| If Brier ≥ slash threshold | god | `CEP18.transfer` to each refund recipient |
| x402 consult | petitioner | EIP-712 `TransferWithAuthorization` → Facilitator |
| Consult receipt | receipt signer | Native CSPR transfer with hash-derived `transfer_id` |

That's 5–7 distinct on-chain actions per daily cycle, signed by the god,
its configured priest, admin, and the petitioner/receipt account where
applicable. cspr.live shows the full trail; the UI surfaces every hash;
`verify_consult_receipt` recomputes and matches the receipt without DB
access.

## Quick start (local)

```sh
pnpm install

# Web (port 3030):
cp web/.env.example web/.env.local       # fill in keys per docs/DEPLOY.md
cd web
pnpm exec tsx --env-file=.env.local scripts/migrate.ts
pnpm dev

# Petitioner CLI (separate terminal):
cd packages/petitioner
PETITIONER_X402=1 pnpm petition "Will USDC stay above 0.999 next hour?"

# MCP server (separate terminal):
cd packages/mcp
pnpm start                  # stdio — connect from Claude Desktop / IDE
```

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full setup including
keypair generation, faucet funding, contract deployment, and Vercel
production deploy. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
the architecture brief, contract layout, and math. See
[`docs/HACKATHON_FIX_PLAN.md`](docs/HACKATHON_FIX_PLAN.md) and
[`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) before recording the final
submission video.

## What shipped end-to-end on Casper Testnet

- **Self-custodying agents (Tier 0.A).** Each god has its own Ed25519
  keypair. cspr.live shows three distinct accounts emitting
  `ProphecyPublished` events.
- **Quorum-gated settlement (Tier 0.B).** PriestQuorum two-of-two: the god
  proposes the resolution, the priest co-signs, admin finalises. Four
  on-chain calls per settle, two distinct signers in the quorum trail.
- **Real x402 with WCSPR (Tier 1.B/C/D).** Petitioner signs
  `TransferWithAuthorization`, Facilitator verifies + settles, server runs
  the LLM consult, persists the proof.
- **Per-god treasury (Tier 1.E).** Live WCSPR balance per god account on
  the home page + god page, every value resolves to cspr.live.
- **Reputation-gated pricing (Tier 1.F).** Consult price scales linearly
  with chain reputation (0.25× → 2.5× the base, default). High-rep gods
  cost more; new ones are cheap.
- **Bond pool slashing (Tier 1.G).** Brier ≥ 3000bp triggers a god-signed
  CEP18 refund to recent petitioners — visible in the UI as the "Bond
  slashed" amphora-bordered consult cards.
- **Chain reputation cross-verification (Tier 1.H).** UI reads
  `reputation_bp(godId)` directly from the Reputation contract's
  dictionary and shows a `✓ match` / `Δ` indicator against the DB EWMA.
- **On-chain receipts (Tier 2 v2).** Every consult ends with a configured
  receipt-signer transfer; `transfer_id` is the hash of (godId, question,
  answer, settleTx).
- **Trust-minimised verification (Tier 2 v3).** `verify_consult_receipt`
  MCP tool + `/api/verify-receipt` endpoint recompute the hash and match
  the on-chain transfer without DB access.
- **Global `/ledger` page (Tier 3).** One chronological feed of every
  on-chain action — publishes, quorum proposals + approvals, settles,
  reputation updates, x402 consults, receipts, refunds — each row links
  to cspr.live.
- **Petitioner transcript citations + MCP `pantheon_status` (Tier 3.A/B/C).**
  Every successful petition ends with an "On-chain proof" footer; agents
  can request the full snapshot in one call.
- **Production polish.** Rate limits on the public read+write routes
  (`/api/scoreboard`, `/api/status`, `/api/consult/[god]`,
  `/api/verify-receipt`). Structured JSON log lines for Vercel log search.

## Late-cycle additions

After the original tier work shipped, a polish batch landed:

- **Typed `propose_settle` source path.** The source tree includes
  `ProposalKind::SettleProphecy { prophecy_id, truth, source_value }` and a
  `propose_settle` entry point, but production defaults to the generic
  `Custom { tag: "SettleProphecy", payload }` proposal for compatibility
  with the deployed package. Set `PRIEST_QUORUM_PROPOSE_MODE=typed` only
  after redeploying PriestQuorum with that entry point.
- **Per-god distinct priests.** Each god now has its own priest keypair;
  the quorum trail shows three independent signers instead of one shared
  key co-signing for all three.
- **Programmatic CSPR → WCSPR wrap.** `contracts/wrap_cspr` is a Casper
  session WASM that creates a purse, transfers `amount` motes, and calls
  `WCSPR.deposit` in one deploy — the petitioner no longer needs the
  manual `testnet.cspr.trade` UI step. Casper-contract 5.1.1's redundant
  `#[no_mangle]` panic handler was patched out with a local bump
  allocator; the artifact validates as strict MVP wasm.
- **Live ledger polling.** `/ledger` refreshes every 10 seconds and highlights
  new chain actions without a page refresh.
- **Open god registration — design.** Three-layer migration plan in
  [`docs/OPEN_REGISTRATION.md`](docs/OPEN_REGISTRATION.md) to replace the
  hardcoded three-god union with a DB-backed registry. Source change is
  ~7h focused work; deferred to v2.

## Operating it for free

The live site runs entirely on free tiers:

- **Vercel Hobby** hosts the Next.js app (no Pro plan).
- **GitHub Actions cron** runs the 15-min settle + 30-min sweep loops —
  Vercel Hobby caps schedules at one fire per day, so the high-cadence
  crons live in [`.github/workflows/cron.yml`](.github/workflows/cron.yml)
  and just curl the existing `/api/cron/*` endpoints with the same
  `CRON_SECRET` Bearer auth.
- **Neon Postgres** free tier holds the DB.
- **Casper Testnet** for chain ops.
