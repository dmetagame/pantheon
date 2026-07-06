# Demo script — 90 second teleprompter

Target length: 90 seconds. Trim aggressively if you go over; the goal is
to make a judge feel the *primitive* — recompute-from-chain reputation,
not a chatbot. Spoken narration in **bold**; click/keyboard actions in
plain text.

## Setup (off-camera)

- One terminal pane open at `~/pantheon/packages/petitioner`. Already
  authed; environment loaded.
- One browser pane open at https://pantheon-silk-three.vercel.app.
- A second browser pane reserved for cspr.live deep-links.
- Run the preflight below. Do not record while reputation verification is
  failing or the ledger shows invalid tx links.

## Preflight (off-camera)

```sh
curl -sS https://pantheon-silk-three.vercel.app/api/status | jq '{totals, gods: [.gods[] | {id, reputationBp, dbReputationBp, reputationVerified, pending:.prophecies_pending, legacy:.prophecies_legacy_blocked}]}'
```

Every god should show `reputationVerified: true`. Pending is fine only when
the pending prophecies settle in the future. `legacyBlocked` rows are older
on-chain publishes from before settlement specs were persisted; they should
be visible as Legacy in the UI, not mixed into the live pending queue.

Open `/ledger` and click the newest publish/propose/approve/settle/reputation
rows. They should all resolve on cspr.live. If a row does not have a real
Casper deploy hash, fix production data before recording.

## Beat 1 — The pitch (≈12s)

Land on `/`.

> **"Pantheon is a calibrated AI-reputation primitive on Casper. Three
> reference agents — Demeter, Hermes, Apollo — publish daily predictions,
> settle them mechanically against public oracles, and accumulate
> Brier-score reputation on chain. Their consult price scales with that
> reputation. When they're confidently wrong, their treasury slashes."**

Hover over a reputation tick (`✓ match`).

> **"Every score on this page is recomputed live from the Reputation
> contract — not our database."**

## Beat 2 — One god's track record (≈18s)

Click into **/god/apollo**.

> **"Apollo is the macro and real-world-assets oracle. Current prophecies
> are sealed with a settlement spec: feed, comparator, threshold. The
> publish tx and the Brier score for the settle are on chain."**

Scroll to a recent settled prophesy. Click its publish tx hash → cspr.live.

> **"That's the actual `ProphecyRegistry.publish` event — feed, threshold,
> confidence in basis points, and settlement timestamp all in the runtime
> args."**

Switch back to the app.

## Beat 3 — The whole pantheon's pulse (≈12s)

Click **The Ledger** in the nav.

> **"Every action — publish, quorum propose, priest approve, settle,
> reputation update, x402 consult, on-chain receipt, slash refund — in one
> chronological feed. Each row links to cspr.live for independent
> verification. This is the audit trail judges can inspect without trusting
> our database."**

(Optional: hover the live-poll indicator showing "polling every 10s".)

## Beat 4 — An AI petitioner consults a god (≈30s)

Switch to terminal.

```sh
PANTHEON_API_URL=https://pantheon-silk-three.vercel.app \
  pnpm petition "Will USDC stay above 0.999 for the next 24 hours?"
```

> **"This is the petitioner — an autonomous Claude agent with three
> tools: list_pantheon, get_god, consult_god. It picks the right god by
> domain match and on-chain reputation, then pays via x402."**

Wait for the transcript. Highlight key turns out loud:

- `list_pantheon` returns
- `get_god demeter` returns — emphasise the Brier-score citations
- `consult_god demeter` returns — that's the real x402 settle
- Final report cites the on-chain proof

> **"The agent picked Demeter — stablecoin domain, modest but honest
> reputation. The final report cites the settle tx hash. That hash plus
> the question and answer are everything a third party needs to verify
> the consult actually happened."**

## Beat 5 — Trust-minimised verification (≈12s)

Switch to a second terminal, paste the verify curl from the README (or
the `verify_consult_receipt` MCP tool):

```sh
curl -X POST https://pantheon-silk-three.vercel.app/api/verify-receipt \
  -H "content-type: application/json" \
  -d '{
        "godId":"demeter",
        "question":"<from transcript>",
        "answer":"<from transcript>",
        "settleTxHash":"<from transcript>"
      }'
```

> **"Recomputes `keccak256(godId | question | answer | settleTx)`, derives
> a `transfer_id`, finds the matching native transfer on cspr.cloud. No
> database trust required. Same logic is available as an MCP tool."**

## Beat 6 — Close (≈6s)

Back to `/`.

> **"Three gods, one primitive. Mechanical settlement. Reputation that
> bites. Verifiable end-to-end on Casper Testnet."**

End on the URL bar.

## Backup beats (cut if over time)

- **MCP server connection.** Open Claude Desktop, show `pantheon_status`
  returning JSON, drives the same UX over stdio.
- **Slash refund.** On `/god/<X>` find a "Bond slashed" amphora card —
  the moment reputation has economic teeth.
- **Quorum trail.** On any settle in `/ledger`, expand to show the
  god-propose + priest-approve + admin-settle sequence.

## Don't say

- Don't say "ChatGPT" / "GPT" — the agents run on Gemini + Claude via
  Vercel AI Gateway.
- Don't say "tokens" without context — judges may hear "ERC-20" first;
  WCSPR is the right name.
- Don't oversell precision: Brier 12.25bp is "excellent", but the words
  "perfect" or "100% accurate" don't fit a calibrated-not-omniscient
  pitch.
