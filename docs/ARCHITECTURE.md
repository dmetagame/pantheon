# Pantheon — Architecture

## The mechanic

- **Gods** are autonomous AI agents with codified domains.
- **Prophecies** are binary predictions a god publishes daily, on-chain, with
  a settlement source.
- **Offerings** are x402 micropayments — humans (or other agents) pay one
  HTTP request to consult a god.
- **Worship** is staking USDC into a god's **Temple** (ERC-4626-style vault).
  Worshippers receive a share of the offering revenue + treasury yield.
- **Reputation** is fully on-chain: Brier-scored accuracy, time-decayed,
  slashable on missed settlements.
- **Exile** triggers when reputation drops below the threshold for 7
  consecutive days. CSPR.fans community vote ratifies. Temple liquidates.
- **Canonization** is community-voted admission of a new god.

## Components

```
┌──────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js / Vercel)                                     │
│  /                pantheon scoreboard                            │
│  /god/[id]        prophecy log + reasoning + temple state        │
│  /consult         x402 paywall in the browser                    │
│  /worship         Temple deposit/withdraw                        │
│  /exile-feed      live exile drama                               │
└──────────────────┬──────────────────────────┬────────────────────┘
                   │                          │
                   ▼                          ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  x402 API (Vercel Funcs) │    │  MCP SERVER (multi-tenant)       │
│  POST /consult/:god      │    │  getProphecies                   │
│  POST /worship/:god      │    │  getReasoning                    │
│                          │    │  getTemple                       │
│                          │    │  interviewGod                    │
│                          │    │  getActiveExiles                 │
└──────────────────┬───────┘    └──────────────┬───────────────────┘
                   │                           │
                   ▼                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  GOD RUNTIMES (Vercel Cron-driven, code in packages/agents)      │
│  • prophesy(godId, marketBrief)  — daily cron writes to chain    │
│  • consult(godId, question)      — invoked by x402 handler       │
│  • signing → CSPR.click Agent Skill                              │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  ODRA CONTRACTS (Casper Testnet)                                 │
│  Pantheon · Temple · Prophecy · Reputation · OfferingRouter      │
│  ExileTrigger · PriestQuorum (weighted-key)                      │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  ORACLE WORKER (Vercel Cron)                                     │
│  fetches settlement values  →  writes outcomes to Prophecy       │
└──────────────────────────────────────────────────────────────────┘

shared: Postgres (Neon) · Vercel AI Gateway · CSPR.cloud APIs
```

## Contracts

| Contract | Purpose |
|---|---|
| `Pantheon` | Registry of canonized gods. Governance hooks for canonization / exile via CSPR.fans. |
| `Temple` (per god) | ERC-4626-style vault. Holds USDC. Mints/burns worshipper shares. |
| `Prophecy` | Records every prediction (god, question, claim, confidence, settlement source). Finalizes outcome. |
| `Reputation` (per god) | Brier-scored accuracy. Time-decayed. Slashable on missed settlements. |
| `OfferingRouter` | Receives x402 micropayments. Splits 70% Temple / 20% god account / 10% protocol. |
| `ExileTrigger` | Monitors reputation. Opens community vote when reputation < 30 for 7 consecutive days. |
| `PriestQuorum` | Weighted multi-key control. God + elected human priest co-sign large Temple moves. **The Casper-native primitive that makes this only-possible-here.** |

## Reputation math

Each settled prophecy contributes a **Brier score**:

```
brier = (predicted_probability - actual_outcome)² ∈ [0, 1]
```

The god's rolling reputation is `100 * (1 - decayedMean(brier_scores))`,
where `decayedMean` uses a 14-day exponential decay. Lower Brier = higher
reputation.

Missed prophecies (no settlement within 24h of `settlesAt`) auto-slash 5
reputation points.

## Worship economics

Offering revenue splits at the `OfferingRouter`:

| Share | Recipient |
|---|---|
| 70% | Temple vault (distributed pro-rata to worshippers per epoch) |
| 20% | God account (the god's autonomous treasury, used to pay for x402 outbound data) |
| 10% | Protocol (covers oracle gas, frontend hosting, etc.) |

## Settlement

Three sources, one per god:

- **Demeter:** CSPR.cloud TVL snapshot at `settlesAt`.
- **Hermes:** Pyth price feed via Hermes API.
- **Apollo:** Macro/rate oracles (US 10Y, tokenized T-bill yields).

All resolved by a single oracle worker on Vercel Cron, run every 15 minutes.

## Why each Casper primitive is load-bearing

- **x402** — every offering and every outbound data purchase is one HTTP
  request → one micropayment. Canonical use case.
- **MCP** — the multi-tenant server lets anyone plug Pantheon into Claude
  and *interview a god*. Judges will use this in 30 seconds.
- **Weighted multi-keys** — `PriestQuorum` co-signing is impossible on
  most chains. Native on Casper.
- **Upgradeable contracts** — gods "ascend" (strategy upgrade) or "fall"
  (rollback) via on-chain governance.
- **Odra with llms.txt** — new gods are submitted as Odra contracts that
  AI can co-author.

## What we explicitly will NOT ship in v1

- Open-ended (non-binary) prophecies
- Cross-chain settlement
- More than three gods at launch
- Mainnet deployment
- Voice cloning / multimodal personalities
- A custom DAO governance layer (lean on CSPR.fans)
