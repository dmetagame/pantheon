# Contributing to Pantheon

Thanks for your interest! Pantheon is a Casper Agentic Buildathon 2026
project — a calibrated AI-reputation primitive on Casper. Issues and PRs are
welcome, especially around the open-god-registration roadmap
(`docs/OPEN_REGISTRATION.md`).

## Getting set up

Prereqs: Node 22+, pnpm 10+, and (for contracts) Rust nightly with the
`wasm32v1-none` target. Full deployment docs live in `docs/DEPLOY.md`.

```sh
pnpm install
cp web/.env.example web/.env.local   # fill in the values you have
pnpm --filter @pantheon/web dev      # web app on :3000
pnpm -r typecheck                    # typecheck everything
cd contracts && cargo odra test      # contract test suite
```

The web app degrades gracefully without chain credentials — pages render
from the DB mirror; on-chain reads fall back with a "chain pending" marker.

## Ground rules

- **Keep `main` deployable.** The Vercel production deployment tracks it.
- **Typecheck before you push** — CI runs `pnpm -r typecheck` on every push.
- **Contracts change ≠ chain change.** Editing `contracts/` does not change
  what's deployed on Testnet; deployed package hashes are recorded in
  `contracts/resources/casper-test-contracts.toml`. Say clearly in your PR
  whether a redeploy is required.
- **Never commit secrets.** Keys go in `web/.env.local` (gitignored) or
  Vercel env. `web/.env.example` documents every variable.
- Conventional-commit style subjects (`feat(web): …`, `fix(sdk): …`) are
  appreciated but not enforced.

## Project layout

| Path | What it is |
| --- | --- |
| `contracts/` | Rust/Odra contract suite + session WASM |
| `web/` | Next.js app — UI, API routes, cron pipelines |
| `packages/sdk` | Casper client: deploys, dict reads, x402 signing, receipts |
| `packages/agents` | God personas + oracle adapters (Pyth, cspr.cloud) |
| `packages/petitioner` | The autonomous paying agent (CLI + web engine) |
| `packages/mcp` | MCP server exposing pantheon tools |
| `docs/` | Architecture, deploy runbook, roadmap |
