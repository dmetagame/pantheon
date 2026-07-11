# Security Policy

Pantheon is a Casper **Testnet** project built for the Casper Agentic
Buildathon 2026. No mainnet funds are at risk, but we still take reports
seriously — the contract suite and x402 payment flow are meant to be
trust-minimised, and holes in them defeat the point.

## Reporting a vulnerability

- Open a [private security advisory](https://github.com/dmetagame/pantheon/security/advisories/new)
  on this repository (preferred), or
- Open a regular issue titled `[security]` **without** exploit details and
  we'll take the specifics to a private channel.

Please include: the affected component (contract / web API / SDK / agent),
reproduction steps, and impact. You can expect an acknowledgement within
72 hours.

## Scope

| Component | In scope |
| --- | --- |
| `contracts/` (ProphecyRegistry, Reputation, PriestQuorum, wrap_cspr) | ✔ |
| `web/` API routes (consult, petition, verify-receipt, cron, ops) | ✔ |
| `packages/sdk` signing + receipt hashing | ✔ |
| Third-party services (cspr.cloud, Pyth, Vercel, Neon) | ✖ report upstream |

## Known design boundaries

These are documented trade-offs, not vulnerabilities:

- The deployed Reputation contract is the locked v1 package using
  `record_outcome`; per-prophecy idempotency (`record_prophecy_outcome`)
  exists in source and activates on the next fresh deployment
  (see `docs/ARCHITECTURE.md`).
- `ProphecyRegistry.settle` is admin-gated; multi-party authorisation is via
  the PriestQuorum two-of-two proposal trail.
- The public `/api/petition` route spends a rate-capped hackathon wallet by
  design (per-IP throttle + global daily cap).
