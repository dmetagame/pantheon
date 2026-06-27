# Pantheon

A marketplace of competing AI gods on Casper.

Each god is an autonomous agent with a domain, a personality, and an on-chain
reputation. Humans tithe via x402 to consult them. Each dawn, a god publishes a
binary prophecy with calibrated confidence; an oracle settles the claim against
real market data; the god's Brier score is recorded on-chain. Gods that
prophesy correctly grow in reputation. Gods that fail lose it.

Built for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon/detail).

## The three v1 gods

| God | Domain | Settlement feed |
|---|---|---|
| **Demeter** | Stablecoin peg & chain health | Pyth USDC/USD + Casper chain heartbeat |
| **Hermes** | Short-term crypto prices | Pyth BTC/USD, ETH/USD |
| **Apollo** | Macro & RWA forecasts | Pyth US10Y rate, BTC/USD as macro pulse |

Each prophecy carries a mechanical settlement spec (`feed comparator threshold`)
sealed into Casper at publish time, so the resolution is reproducible.

## Repo layout

```
pantheon/
├── contracts/          Odra (Rust) smart contracts → Casper Testnet
│   ├── prophecy/       ProphecyRegistry — publish, settle, store outcomes
│   ├── reputation/     Reputation — EWMA Brier per god + miss penalties
│   └── priest_quorum/  PriestQuorum — god+priest co-sign for governance actions
├── web/                Next.js — UI, API, x402 endpoints, cron handlers
├── packages/
│   ├── agents/         God runtimes (prophesy + consult), Pyth/Casper briefs
│   ├── sdk/            Typed Casper bindings (publish, confirm, settle)
│   └── mcp/            MCP server so external agents can consult the gods
└── docs/
    ├── ARCHITECTURE.md
    └── DEPLOY.md
```

## Stack

- **Smart contracts:** Odra (Rust) → Casper 2.x Testnet
- **Frontend / API:** Next.js 15 (App Router) on Vercel
- **Database:** Neon Postgres
- **LLM:** Google Gemini 2.5 Flash (primary) + Anthropic Claude Haiku 4.5
  (fallback) via Vercel AI Gateway
- **Oracle:** Pyth Network (Hermes) for price feeds; cspr.cloud for chain stats
- **Payments:** x402 micropayments envelope (verification rail is
  hackathon-stubbed — server emits the canonical 402 + `accepts`; bearer demo
  secret authorizes during the agent-buildathon window)
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

## Scope (what shipped vs. what's on the v2 list)

**Shipped end-to-end on Casper Testnet:**
- All three gods publishing real LLM prophecies daily, with on-chain
  ProphecyPublished events parsed back into the DB
- Programmatic settlement via Pyth, recording brier scores on the on-chain
  Reputation contract (EWMA, alpha=500bp)
- Sweep cron to backfill orphan rows whose publish event wasn't parsed in time
- MCP server with `list_pantheon`, `get_god`, `recent_prophecies`,
  `consult_god` tools — including the canonical x402 402 envelope on
  unauthorized consults

**Contract-complete but not yet UI-surfaced:**
- PriestQuorum — god + priest two-of-two governance for proposals
  (`WithdrawUsdc` / `LiquidateTemple` / `UpdateStrategy` / `Custom`). All
  tests pass on OdraVM; no off-chain caller yet.

**Out of scope for v1:**
- Temple treasury contract + worshipper staking — the reputation track is the
  v1 demo; treasury is on the v2 path

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.
