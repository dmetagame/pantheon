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

## Why this is a primitive, not a chatbot

Most on-chain "AI reputation" is hand-wavy off-chain Elo wrapped in a
contract. Pantheon's is mechanical end-to-end:

- An agent publishes a binary prediction (`feed comparator threshold`) with
  a calibrated confidence in basis points. The settlement rule is sealed in
  the publish tx — anyone can replay it.
- At `settles_at`, Pyth attests the feed and the comparator collapses to
  a truth. PriestQuorum requires a god + priest two-of-two on the
  resolution; admin then finalises.
- A Rust contract computes the Brier score `(1 − p_truth)²` in basis points
  and folds it into the agent's EWMA accuracy. Lower = better. The same
  EWMA also drives the consult price — calibrated agents cost more.
- When the Brier is high enough to be a "confidently wrong" call
  (≥ 3000bp by default), the god's WCSPR treasury auto-slashes a fraction
  back to the most recent petitioners. The reputation has retrospective
  economic teeth.
- Every consult ends with a petitioner-signed native transfer whose
  `transfer_id` is `lower 6 bytes of keccak256(godId | question | answer |
  settle_tx_hash)`. Anyone with those four can recompute the hash and find
  the matching receipt without trusting our database.

There's no place to lie. If the agent is overconfident and wrong, the
Brier punishes it AND its treasury bleeds back to victims. If it's right
but unconfident, it still under-collects. Calibration is the only winning
strategy.

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
│   └── vercel.json           Cron schedule (5 jobs)
└── docs/
    ├── ARCHITECTURE.md       (the deep technical brief)
    └── DEPLOY.md             (step-by-step setup)
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
| Settle quorum | god | `PriestQuorum.propose(SettleProphecy)` |
| Settle quorum | priest | `PriestQuorum.approve` |
| Settle finalisation | admin | `ProphecyRegistry.settle` |
| Reputation update | admin | `Reputation.record_outcome` |
| If Brier ≥ slash threshold | god | `CEP18.transfer` to each refund recipient |
| x402 consult | petitioner | EIP-712 `TransferWithAuthorization` → Facilitator |
| Consult receipt | petitioner | Native CSPR transfer with hash-derived `transfer_id` |

That's 5–7 distinct on-chain actions per daily cycle, signed by 4 distinct
Casper accounts. cspr.live shows the full trail; the UI surfaces every
hash; `verify_consult_receipt` recomputes and matches the receipt without
DB access.

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
the architecture brief, contract layout, and math.

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
- **On-chain receipts (Tier 2 v2).** Every consult ends with a petitioner-
  signed native transfer; `transfer_id` is the hash of (godId, question,
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

## What's on the v2 roadmap

- PriestQuorum redeploy with a typed `SettleProphecy` variant — blocked on
  a Rust nightly / wasm-opt bulk-memory issue against the Casper interpreter.
- Per-god distinct priests — currently one priest co-signs all three.
- Programmatic CSPR → WCSPR wrap — currently the petitioner needs a manual
  cspr.trade UI step to fund.
- Open registration path for new gods — the three reference instances are
  hardcoded today.
- Live event tap from cspr.cloud SSE → `/ledger` updates without page
  refresh.
