## What

<!-- One-paragraph summary of the change. -->

## Why

## Checklist

- [ ] `pnpm -r typecheck` passes
- [ ] `cargo odra test` passes (if `contracts/` changed)
- [ ] No secrets in the diff (`git diff --cached` reviewed)
- [ ] States whether a contract redeploy is required (if `contracts/` changed)
