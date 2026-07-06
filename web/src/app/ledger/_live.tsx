"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GOD_ACCENT } from "../_sigils";
import type { GodId } from "@pantheon/agents";

export type LedgerKind =
  | "publish"
  | "propose"
  | "approve"
  | "settle"
  | "reputation"
  | "consult-settle"
  | "consult-receipt"
  | "refund";

export interface LedgerEntryWire {
  ts: string;
  god_id: GodId;
  kind: LedgerKind;
  tx_hash: string;
  detail: string;
  prophecy_id: number | null;
  consult_id: number | null;
}

const EXPLORER = "https://cspr.live/deploy";
const DEPLOY_HASH_RE = /^[0-9a-fA-F]{64}$/;

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

const GOD_NAME: Record<GodId, string> = {
  demeter: "Demeter",
  hermes: "Hermes",
  apollo: "Apollo",
};

function fmtRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days}d ago`;
  if (h >= 1) return `${h}h ago`;
  if (m >= 1) return `${m}m ago`;
  return "<1m ago";
}

function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function DeployLink({ hash }: { hash: string }) {
  if (!DEPLOY_HASH_RE.test(hash)) {
    return (
      <span className="font-mono text-[11px] text-ink/30">
        unverified
      </span>
    );
  }
  return (
    <a
      href={`${EXPLORER}/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[11px] text-ink/40 hover:text-gold"
    >
      {short(hash)} ↗
    </a>
  );
}

function rowKey(e: LedgerEntryWire): string {
  return `${e.tx_hash}:${e.kind}`;
}

interface Props {
  initial: LedgerEntryWire[];
  pollMs?: number;
}

export function LiveLedger({ initial, pollMs = 10_000 }: Props) {
  const [entries, setEntries] = useState<LedgerEntryWire[]>(initial);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const seenRef = useRef<Set<string>>(new Set(initial.map(rowKey)));

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/ledger?limit=150`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { entries: LedgerEntryWire[] };
        const seen = seenRef.current;
        const newKeys = new Set<string>();
        for (const e of data.entries) {
          const k = rowKey(e);
          if (!seen.has(k)) newKeys.add(k);
        }
        if (newKeys.size > 0) {
          for (const k of newKeys) seen.add(k);
          setEntries(data.entries);
          setFresh(newKeys);
          // Decay the highlight after a few seconds.
          window.setTimeout(() => {
            if (cancelled) return;
            setFresh(new Set());
          }, 4_000);
        }
      } catch {
        // swallow — next tick will retry.
      }
    }

    const id = window.setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [paused, pollMs]);

  return (
    <>
      <div className="mb-3 flex items-center justify-between text-[11px] text-ink/50">
        <span>
          {entries.length} entries · polling{" "}
          {paused ? (
            <button
              type="button"
              onClick={() => setPaused(false)}
              className="text-gold hover:underline"
            >
              paused
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPaused(true)}
              className="hover:text-gold"
            >
              every {Math.round(pollMs / 1000)}s
            </button>
          )}
        </span>
        {fresh.size > 0 && (
          <span className="rounded-full border border-gold/40 bg-gold/5 px-2 py-0.5 text-gold">
            ↑ {fresh.size} new
          </span>
        )}
      </div>
      <ul>
        {entries.map((e) => {
          const accent = GOD_ACCENT[e.god_id];
          const k = rowKey(e);
          const isFresh = fresh.has(k);
          return (
            <li
              key={k}
              className={
                "grid grid-cols-[auto_1fr_auto] items-baseline gap-3 border-b border-ink/5 px-1 py-2.5 text-sm transition-colors last:border-0 " +
                (isFresh ? "bg-gold/5" : "")
              }
            >
              <span
                className={`inline-block size-2 translate-y-[3px] rounded-full ${KIND_DOT[e.kind]}`}
                title={KIND_LABEL[e.kind]}
              />
              <div className="min-w-0">
                <p className="truncate">
                  <Link
                    href={`/god/${e.god_id}`}
                    className={`font-medium ${accent.text} hover:underline`}
                  >
                    {GOD_NAME[e.god_id]}
                  </Link>{" "}
                  <span className="text-ink/60">— {KIND_LABEL[e.kind]}</span>
                  <span className="text-ink/40"> · {e.detail}</span>
                </p>
              </div>
              <DeployLink hash={e.tx_hash} />
              <span />
              <p className="text-[11px] text-ink/40">
                {fmtRelative(new Date(e.ts))}
              </p>
              <span />
            </li>
          );
        })}
      </ul>
    </>
  );
}
