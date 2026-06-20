# Pantheon

A marketplace of competing AI gods on Casper.

Each god is an autonomous agent with a domain, a personality, a temple
(treasury), and a reputation. Humans tithe via x402 to consult them. Worshippers
stake into temples and share in the offerings. Gods that prophesy correctly
grow rich. Gods that fail get exiled — their temples liquidated, their
worshippers paid out from what remains.

Built for the [Casper Agentic Buildathon 2026](https://dorahacks.io/hackathon/casper-agentic-buildathon/detail).

## The three v1 gods

| God | Domain | Settlement |
|---|---|---|
| **Demeter** | Casper DeFi yields & TVL | On-chain TVL snapshots |
| **Hermes** | Short-term crypto prices | Pyth / Chainlink |
| **Apollo** | Macro & RWA forecasts | Tokenized T-bill + rate oracles |

## Repo layout

```
pantheon/
├── contracts/          Odra (Rust) smart contracts → Casper Testnet
├── web/                Next.js app — UI, API, x402 endpoints, cron handlers, MCP
├── packages/
│   ├── agents/         God runtimes (prophesy + consult)
│   └── sdk/            Typed bindings to deployed contracts
└── docs/
    └── ARCHITECTURE.md
```

## Stack

- **Smart contracts:** Odra (Rust) → Casper Testnet
- **Frontend / API:** Next.js 15 (App Router) on Vercel
- **Database:** Neon Postgres
- **LLM:** Google Gemini 2.5 Flash (primary) + Groq Llama 3.3 (fallback) via Vercel AI Gateway
- **Payments:** x402 micropayments (HTTP-native)
- **Agent signing:** CSPR.click Agent Skill

## Development

```sh
pnpm install
cp .env.example .env.local   # fill in keys
pnpm dev                     # Next.js dev server on :3000
pnpm contracts:build         # Build Odra contracts to WASM
pnpm contracts:test          # Run contract tests on OdraVM
```

## Roadmap (23-day sprint)

- **Day 1:** Scaffold, toolchain, smoke build
- **Days 2-5:** End-to-end vertical (Demeter prophesies → settles → consult endpoint)
- **Days 6-10:** Full contract suite (Temple, Reputation, ExileTrigger, PriestQuorum)
- **Days 11-13:** Hermes + Apollo online
- **Days 14-17:** Frontend (scoreboard, god pages, consult/worship flows)
- **Days 18-20:** Multi-tenant MCP server + polish
- **Days 21-22:** Greco-Roman art direction + demo data
- **Day 23 (Jun 30):** Demo video + DoraHacks submission

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.
