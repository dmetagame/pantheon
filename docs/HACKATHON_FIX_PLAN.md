# Hackathon Fix Plan

Source of truth for judging: https://dorahacks.io/hackathon/casper-agentic-buildathon/detail

The qualification gate is simple: a working Casper Testnet prototype with
transaction-producing on-chain components, open source docs, and a demo video.
The final judging rubric then weights technical execution, originality,
agentic AI, real-world applicability with DeFi/RWA strength, UX, working
contracts, launch plans, and impact.

## P0: Demo Correctness

These are non-negotiable before recording.

1. Deploy the latest web/API code and run every migration.
2. Clean invalid demo tx hashes from production Postgres.
3. Fix live Reputation alignment so chain reputation and DB EWMA match.
4. Drain claimable overdue settlement rows until only future prophecies
   remain pending. Legacy rows with missing settlement specs must be shown
   separately as `legacyBlocked`, not counted as live pending debt.
5. Verify `/ledger` has no fake links and `/api/status` reports
   `reputationVerified: true` for every god.

### Production SQL Repair

Run this only after taking a Neon snapshot. Preferred path:

```sh
cd web
pnpm exec tsx --env-file=.env.local scripts/repair-production-data.ts
```

If you need to run SQL manually, null invalid tx hashes for all columns on a
row in a single `UPDATE`; once hash constraints exist, one-column-at-a-time
cleanup can fail because Postgres rechecks every constraint on the row.

```sql
BEGIN;

UPDATE prophecies
SET tx_hash = CASE WHEN tx_hash IS NOT NULL AND tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE tx_hash END,
    propose_tx_hash = CASE WHEN propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE propose_tx_hash END,
    quorum_proposal_id = CASE WHEN propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE quorum_proposal_id END,
    approve_tx_hash = CASE WHEN approve_tx_hash IS NOT NULL AND approve_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE approve_tx_hash END,
    settle_tx_hash = CASE WHEN settle_tx_hash IS NOT NULL AND settle_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE settle_tx_hash END,
    reputation_backfilled = CASE WHEN reputation_tx_hash = 'backfilled-pre-tier-0-review' THEN TRUE ELSE reputation_backfilled END,
    reputation_tx_hash = CASE WHEN reputation_tx_hash IS NOT NULL AND reputation_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE reputation_tx_hash END
WHERE (tx_hash IS NOT NULL AND tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (propose_tx_hash IS NOT NULL AND propose_tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (approve_tx_hash IS NOT NULL AND approve_tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (settle_tx_hash IS NOT NULL AND settle_tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (reputation_tx_hash IS NOT NULL AND reputation_tx_hash !~ '^[0-9a-fA-F]{64}$');

UPDATE consultations
SET payment_tx_hash = CASE WHEN payment_tx_hash IS NOT NULL AND payment_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE payment_tx_hash END,
    receipt_tx_hash = CASE WHEN receipt_tx_hash IS NOT NULL AND receipt_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE receipt_tx_hash END,
    refund_tx_hash = CASE WHEN refund_tx_hash IS NOT NULL AND refund_tx_hash !~ '^[0-9a-fA-F]{64}$' THEN NULL ELSE refund_tx_hash END
WHERE (payment_tx_hash IS NOT NULL AND payment_tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (receipt_tx_hash IS NOT NULL AND receipt_tx_hash !~ '^[0-9a-fA-F]{64}$')
   OR (refund_tx_hash IS NOT NULL AND refund_tx_hash !~ '^[0-9a-fA-F]{64}$');

COMMIT;
```

Then validate the hash constraints added by migration `0006_tx_hash_guards.sql`.

```sql
ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_tx_hash_format;
ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_propose_tx_hash_format;
ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_approve_tx_hash_format;
ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_settle_tx_hash_format;
ALTER TABLE prophecies VALIDATE CONSTRAINT prophecies_reputation_tx_hash_format;
ALTER TABLE consultations VALIDATE CONSTRAINT consultations_payment_tx_hash_format;
ALTER TABLE consultations VALIDATE CONSTRAINT consultations_receipt_tx_hash_format;
ALTER TABLE consultations VALIDATE CONSTRAINT consultations_refund_tx_hash_format;
```

### Reputation Repair

The current live Reputation package is locked v1 and uses `record_outcome`.
Do not replay settled history against that package: the legacy entrypoint is
not prophecy-idempotent and would double-count samples. Only use the replay
flow after deploying a fresh Reputation package that exposes
`record_prophecy_outcome`, then set:

```sh
REPUTATION_OUTCOME_ENTRYPOINT=record_prophecy_outcome
```

If the configured Reputation contract is that fresh package and currently
reads zero while the DB contains settled history, replay all settled outcomes:

```sh
cd web
REPLAY_ALL_REPUTATION=1 pnpm reputation:reconcile
```

For normal future recovery on the fresh package, omit `REPLAY_ALL_REPUTATION`;
the script only records rows that are missing a reputation tx/backfill marker.

### Settlement Backlog

Run the settle cron repeatedly with the production `CRON_SECRET` until it
returns no due rows and `/api/status` has no overdue claimable pending
prophecies. `/api/ops/repair` preflight separates `settleQueueReady`,
`settleQueuePaused`, and `blockedMissingSpec`.

```sh
curl -sS \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://pantheon-silk-three.vercel.app/api/cron/settle
```

## P1: Trust Guarantees

Already implemented in code in this pass:

- `ProphecyRegistry.settle` now rejects settlement before `settles_at`.
- Slashing has persistent `slash_status`, retry timestamps, and errors.
- `reputation_tx_hash` is reserved for real Casper deploy hashes; legacy
  chain-acknowledged rows use `reputation_backfilled`.
- `/api/verify-receipt` validates deploy hash shape, payload sizes, expected
  god recipient, and the configured receipt signer when available.
- `next.config.ts` adds CSP, anti-framing, MIME, referrer, and browser
  permissions headers.

## P2: Hackathon Narrative

Frame the demo around the official rubric:

- Technical execution: Rust/Odra contracts, typed SDK, cron settlement,
  application-level replay safety, chain-read reputation checks, and live tx
  links.
- Innovation: Brier-score reputation is a reusable primitive, not a chatbot.
- Agentic AI: petitioner agent selects a god and pays via x402.
- DeFi/RWA: Apollo covers macro/RWA signals; x402/WCSPR gives economic flow.
- UX: scoreboard, per-god pages, ledger, receipt verifier.
- Working contracts: publish, quorum propose/approve, settle, reputation,
  receipt, slash refund.
- Launch path: open god registration, more feeds, richer RWA settlement.

## P3: After Submission

- Replace hardcoded gods with the open registration plan.
- Move settlement finalisation from admin to direct contract-to-contract
  writer once Casper tooling makes it ergonomic.
- Add a first-class RWA data provider beyond the current macro proxy feeds.
- Make partial slash retries track recipient-level retry state.
