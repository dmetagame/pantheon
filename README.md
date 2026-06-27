# Pantheon

**A calibrated AI-reputation primitive on Casper.**

Pantheon is a Rust contract suite + service that lets AI agents commit to
binary predictions with calibrated confidence, settle them mechanically against
public oracles, and accumulate a tamper-resistant Brier-score reputation on
chain. Each settlement is co-signed by the agent and a priest under a quorum
contract, so the reputation that emerges has been *witnessed* — not asserted by
an operator.

Demeter, Hermes, and Apollo are the three reference instances we ship for the
[Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon/detail).
Each is a self-custodying AI agent on Casper Testnet with its own keypair and
domain. Any agent author can deploy a fourth.

## Why this is a primitive, not a chatbot

Most on-chain "AI reputation" systems are off-chain Elo scores wrapped in a
contract. Pantheon's is mechanical:

- An agent publishes a binary prediction (`feed comparator threshold`) with a
  calibrated confidence in basis points. The settlement rule is sealed in the
  publish tx so the resolution is reproducible by anyone.
- At settles-at, a public oracle (Pyth) attests the value. The boolean
  comparator collapses to a truth.
- An on-chain Rust contract computes the Brier score: `(1 − p_truth)²` in basis
  points. The agent's per-instance accuracy moves under an EWMA with α = 500bp,
  matching the chain's formula exactly.
- The settlement is gated by a two-of-two priest quorum: the agent proposes,
  the priest co-signs, the admin finalises. Four on-chain calls per
  settlement, two distinct signing accounts, fully replayable.

There's no place to lie. If the agent is overconfident and wrong, the Brier
score punishes it proportionally. If it's right but unconfident, it still
under-collects on reputation. Calibration is the only winning strategy.

## The three reference gods

| God | Domain | Settlement feed |
|---|---|---|
| **Demeter** | Stablecoin peg & chain health | Pyth USDC/USD + Casper chain heartbeat |
| **Hermes** | Short-term crypto prices | Pyth BTC/USD, ETH/USD |
| **Apollo** | Macro & RWA forecasts | Pyth US10Y rate, BTC/USD as macro pulse |

Each runs the same primitive — they only differ in domain prompt, allowed
feeds, and personality. Reputation is computed by the same Rust contract for
all three.

## Repo layout

```
pantheon/
├── contracts/          Odra (Rust) smart contracts → Casper Testnet
│   ├── prophecy/       ProphecyRegistry — publish, settle, store outcomes
│   ├── reputation/     Reputation — EWMA Brier per agent + miss penalties
│   └── priest_quorum/  PriestQuorum — agent+priest co-sign for settlement
├── web/                Next.js — UI, API, x402 endpoints, cron handlers
├── packages/
│   ├── agents/         Agent runtimes (prophesy + consult), Pyth/Casper briefs
│   ├── sdk/            Typed Casper bindings + bytesrepr encoders
│   └── mcp/            MCP server so external agents can consult the gods
└── docs/
    ├── ARCHITECTURE.md
    └── DEPLOY.md
```

## Stack

- **Smart contracts:** Odra 2.7 (Rust) → Casper 2.x Testnet
- **Frontend / API:** Next.js 15 (App Router) on Vercel
- **Database:** Neon Postgres
- **LLM:** Google Gemini 2.5 Flash (primary) + Anthropic Claude Haiku 4.5
  (fallback) via Vercel AI Gateway
- **Oracle:** Pyth Network (Hermes) for price feeds; cspr.cloud for chain stats
- **Payments:** x402 micropayments envelope (the verification rail is
  hackathon-stubbed — the server emits the canonical 402 + `accepts` envelope;
  a bearer demo secret authorises during the agent-buildathon window)
- **Agent interface:** Model Context Protocol stdio server (`@pantheon/mcp`)

## Development

```sh
pnpm install
cp web/.env.example web/.env.local   # fill in keys
pnpm --filter @pantheon/web dev      # Next.js dev server on :3030

# contracts:
cd contracts && cargo build --release
cargo test
```

## What shipped, what didn't

**Shipped end-to-end on Casper Testnet:**
- **Self-custodying agents.** Each god has its own Ed25519 keypair and signs
  its own publishes. cspr.live shows three distinct accounts emitting
  ProphecyPublished events — not one operator running three bots.
- **Quorum-gated settlement.** Each settlement is a four-tx ceremony: the god
  proposes to PriestQuorum, the priest approves, the admin finalises
  ProphecyRegistry.settle, the admin records the outcome on Reputation. The
  proposal payload (`prophecy_id, truth, source_value`) is sealed in the
  quorum's Custom variant as Odra bytesrepr.
- **Programmatic settlement via Pyth** with on-chain Reputation EWMA.
- **Sweep cron** to backfill orphan rows whose publish event wasn't parsed in
  time.
- **MCP server** with `list_pantheon`, `get_god`, `recent_prophecies`,
  `consult_god` tools — including the canonical x402 402 envelope on
  unauthorized consults.
- **Per-prophecy proof on-chain.** The god page surfaces up to four tx links
  per settled prophecy plus the quorum proposal id, all linking to cspr.live.

**On the v2 list:**
- **PriestQuorum upgrade.** The deployed contract has a generic `Custom`
  variant; the working tree has a typed `SettleProphecy` variant + a
  `propose_settle` entry-point that bypasses the JS-side enum encoder. The
  upgrade is blocked on a Rust nightly / wasm-opt issue (bulk-memory ops the
  Casper interpreter rejects). The deployed encoding works and is fully
  replayable; the upgrade is cleaner.
- **Priest decentralisation.** v1 priest = admin across all three gods. v2
  splits the priest role per god.
- **Real x402 settlement** against the Casper Facilitator (the wire envelope
  is correct; the settlement rail is bearer-stubbed for now).
- **Treasury per god.** The Brier-tracked reputation does not yet gate
  payouts. A Temple contract that takes consult tithes, accumulates per-god
  USDC, and pays a bond pool on broken prophecies is the next big primitive
  extension.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.
