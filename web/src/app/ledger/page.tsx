import Link from "next/link";
import { getLedger, type LedgerKind } from "@/lib/ledger";
import type { GodId } from "@pantheon/agents";
import { LiveLedger, type LedgerEntryWire } from "./_live";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<LedgerKind, string> = {
  publish: "publish",
  propose: "propose",
  approve: "approve",
  settle: "settle",
  reputation: "reputation",
  "consult-settle": "x402 settle",
  "consult-receipt": "receipt",
  refund: "refund",
};

// Per-kind dot color so a scanner can pick out the rhythm of activity by type.
const KIND_DOT: Record<LedgerKind, string> = {
  publish: "bg-laurel",
  propose: "bg-laurel/70",
  approve: "bg-amphora/80",
  settle: "bg-ink/70",
  reputation: "bg-ink/40",
  "consult-settle": "bg-gold",
  "consult-receipt": "bg-gold/60",
  refund: "bg-amphora",
};

export default async function LedgerPage() {
  const entries = await getLedger(150);
  const kinds = Array.from(new Set(entries.map((e) => e.kind)));
  const gods = Array.from(new Set(entries.map((e) => e.god_id))) as GodId[];

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href="/"
        className="text-xs uppercase tracking-[0.3em] text-ink/50 hover:text-gold"
      >
        ← Pantheon
      </Link>

      <header className="mt-8 border-b border-ink/10 pb-8">
        <p
          className="text-xs uppercase tracking-[0.3em] text-amphora"
          data-hero=""
        >
          The Ledger
        </p>
        <h1
          className="mt-2 text-4xl font-light italic"
          style={{ fontFamily: "var(--font-display)" }}
          data-hero=""
        >
          Every action, on chain.
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-ink/60" data-hero="">
          One feed of every artifact the Pantheon has committed to Casper —
          prophesies and the quorum that resolved them, x402 settlements and
          the receipts that bound them, slash refunds when a god&apos;s call
          was confidently wrong. Each row links to testnet.cspr.live for
          independent verification.
        </p>
        <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink/50">
          {kinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`inline-block size-2 rounded-full ${KIND_DOT[k]}`} />
              {KIND_LABEL[k]}
            </span>
          ))}
          <span className="text-ink/30">·</span>
          <span>
            {entries.length} entries across {gods.length} god
            {gods.length === 1 ? "" : "s"}
          </span>
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="mt-12 text-ink/50">
          No on-chain activity yet. The Pantheon is silent.
        </p>
      ) : (
        <div className="mt-6">
          <LiveLedger
            initial={entries.map(
              (e): LedgerEntryWire => ({
                ts: e.ts.toISOString(),
                god_id: e.god_id,
                kind: e.kind,
                tx_hash: e.tx_hash,
                detail: e.detail,
                prophecy_id: e.prophecy_id ?? null,
                consult_id: e.consult_id ?? null,
              }),
            )}
          />
        </div>
      )}

      <footer className="mt-16 border-t border-ink/10 pt-6 text-xs text-ink/50">
        Anyone can independently verify each row via testnet.cspr.live. Consult
        receipts can be re-derived with{" "}
        <code className="rounded-sm bg-ink/5 px-1 py-0.5 font-mono text-[11px]">
          verify_consult_receipt
        </code>{" "}
        on the MCP server.
      </footer>
    </main>
  );
}
