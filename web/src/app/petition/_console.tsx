"use client";

// Live petition console. Streams NDJSON events from /api/petition and
// renders the agent transcript as it happens — the same feed the CLI
// prints, dressed for the temple.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface ProofData {
  god?: string;
  reputationBp?: number;
  paymentSettleTx?: string;
  paymentAmountMotes?: string;
  receiptTxHash?: string;
  receiptHashHex?: string;
  payer?: string;
  question?: string;
  answer?: string;
}

type Event =
  | { type: "turn"; index: number; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; preview: string }
  | { type: "final"; text: string }
  | { type: "proof"; proof: ProofData }
  | { type: "done" }
  | { type: "error"; message: string };

const SUGGESTED = [
  "Will BTC trade above $100,000 in the next 24 hours?",
  "Will the US 10-Year Treasury yield close above 4.25% at the end of the next trading day?",
  "Will USDC hold its dollar peg above $0.9995 through tomorrow?",
];

const TRANSACTION_URL =
  process.env.NEXT_PUBLIC_CASPER_EXPLORER_TRANSACTION_URL ??
  "https://testnet.cspr.live/transaction";
const ACCOUNT_URL = "https://testnet.cspr.live/account";

function fmtMotes(motes?: string): string {
  if (!motes) return "—";
  const v = BigInt(motes);
  const d = 10n ** 9n;
  const frac = (v % d).toString().padStart(9, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${v / d}.${frac} WCSPR` : `${v / d} WCSPR`;
}

function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function PetitionConsole() {
  const [question, setQuestion] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events, running]);

  async function run() {
    const q = question.trim();
    if (q.length < 8 || running) return;
    setEvents([]);
    setError(null);
    setRunning(true);
    try {
      const res = await fetch("/api/petition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          retryAfterSeconds?: number;
        } | null;
        const wait = body?.retryAfterSeconds
          ? ` Try again in ${Math.ceil(body.retryAfterSeconds / 60)} min.`
          : "";
        throw new Error((body?.error ?? `request failed (${res.status})`) + wait);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as Event;
          if (e.type === "error") setError(e.message);
          else setEvents((prev) => [...prev, e]);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const proof = events.find((e): e is Extract<Event, { type: "proof" }> => e.type === "proof")?.proof;

  function stashForVerify() {
    if (!proof?.god || !proof.question || !proof.answer || !proof.paymentSettleTx) return;
    sessionStorage.setItem(
      "verify-prefill",
      JSON.stringify({
        godId: proof.god,
        question: proof.question,
        answer: proof.answer,
        settleTxHash: proof.paymentSettleTx,
      }),
    );
  }

  return (
    <section className="mt-8">
      <div className="rounded-sm border border-ink/15 bg-marble/60 p-5">
        <label
          htmlFor="petition-q"
          className="text-[10px] uppercase tracking-wider text-ink/50"
        >
          Your question — binary, near-term, inside an oracle&apos;s domain
        </label>
        <textarea
          id="petition-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={300}
          placeholder="Will BTC trade above $100,000 in the next 24 hours?"
          className="mt-2 w-full resize-none rounded-sm border border-ink/20 bg-marble px-3 py-2 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-gold"
          disabled={running}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {SUGGESTED.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setQuestion(s)}
                disabled={running}
                className="rounded-full border border-ink/15 px-3 py-1 text-[11px] text-ink/60 transition hover:border-gold hover:text-gold disabled:opacity-40"
              >
                {s.length > 46 ? `${s.slice(0, 46)}…` : s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={run}
            disabled={running || question.trim().length < 8}
            className="rounded-sm border border-gold bg-gold/10 px-5 py-2 text-xs font-medium uppercase tracking-[0.2em] text-ink transition hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Petitioning…" : "Petition"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-sm border border-amphora/40 bg-amphora/10 px-4 py-3 text-sm text-amphora">
          {error}
        </p>
      )}

      {(events.length > 0 || running) && (
        <div className="mt-6 space-y-3">
          {events.map((e, i) => {
            switch (e.type) {
              case "turn":
                return (
                  <div
                    key={i}
                    className="rounded-sm border border-ink/10 bg-marble/50 p-4"
                  >
                    <p className="text-[10px] uppercase tracking-wider text-amphora">
                      Petitioner · turn {e.index + 1}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/80">
                      {e.text}
                    </p>
                  </div>
                );
              case "tool_call":
                return (
                  <p key={i} className="px-2 font-mono text-[11px] text-laurel">
                    → {e.name}({e.args})
                  </p>
                );
              case "tool_result":
                return (
                  <p
                    key={i}
                    className="break-all px-2 font-mono text-[11px] text-ink/35"
                  >
                    ← {e.name}: {e.preview}
                  </p>
                );
              case "final":
                return (
                  <div
                    key={i}
                    className="rounded-sm border border-gold/50 bg-gold/[0.06] p-5"
                  >
                    <p className="text-[10px] uppercase tracking-wider text-gold">
                      Final report
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/90">
                      {e.text}
                    </p>
                  </div>
                );
              default:
                return null;
            }
          })}

          {running && (
            <p className="animate-pulse px-2 font-mono text-[11px] text-ink/40">
              the temple deliberates…
            </p>
          )}

          {proof && (
            <div className="rounded-sm border border-laurel/40 bg-laurel/[0.06] p-5">
              <p className="text-[10px] uppercase tracking-wider text-laurel">
                On-chain proof
              </p>
              <dl className="mt-3 space-y-1.5 font-mono text-[12px] text-ink/75">
                {proof.god && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">god consulted</dt>
                    <dd className="capitalize">{proof.god}</dd>
                    {proof.reputationBp !== undefined && (
                      <dd className="text-ink/45">
                        · trusted at {(proof.reputationBp / 100).toFixed(2)}%
                      </dd>
                    )}
                  </div>
                )}
                {proof.paymentSettleTx && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">x402 settle</dt>
                    <dd>
                      <a
                        href={`${TRANSACTION_URL}/${proof.paymentSettleTx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-laurel underline-offset-2 hover:underline"
                      >
                        {shortHash(proof.paymentSettleTx)} ↗
                      </a>{" "}
                      <span className="text-ink/45">
                        {fmtMotes(proof.paymentAmountMotes)}
                      </span>
                    </dd>
                  </div>
                )}
                {proof.receiptTxHash && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">receipt</dt>
                    <dd>
                      <a
                        href={`${TRANSACTION_URL}/${proof.receiptTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-laurel underline-offset-2 hover:underline"
                      >
                        {shortHash(proof.receiptTxHash)} ↗
                      </a>
                    </dd>
                  </div>
                )}
                {proof.payer && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">petitioner</dt>
                    <dd>
                      <a
                        href={`${ACCOUNT_URL}/${proof.payer}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-laurel underline-offset-2 hover:underline"
                      >
                        {shortHash(proof.payer)} ↗
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
              {proof.question && proof.answer && proof.paymentSettleTx && (
                <Link
                  href="/verify"
                  onClick={stashForVerify}
                  className="mt-4 inline-block rounded-sm border border-laurel/50 px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] text-laurel transition hover:bg-laurel/10"
                >
                  Verify this receipt →
                </Link>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </section>
  );
}
