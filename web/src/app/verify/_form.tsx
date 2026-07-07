"use client";

// Receipt verifier form. Posts the four receipt inputs to
// /api/verify-receipt and renders the recomputed trust chain. Prefills
// from sessionStorage when the visitor arrives via a petition run's
// "Verify this receipt" button.

import { useEffect, useState } from "react";

const GODS = ["demeter", "hermes", "apollo"] as const;

interface VerifyResponse {
  verified: boolean;
  error?: string;
  expected?: {
    receiptHashHex: string;
    transferId: string;
    godAccountKey: string;
    receiptSignerAccountKey?: string | null;
  };
  match?: {
    deployHash: string;
    amount: string;
    initiator: string;
    recipient: string;
    timestamp: string;
  } | null;
}

const DEPLOY_URL = "https://cspr.live/deploy";

function shortHex(h: string): string {
  return h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-8)}` : h;
}

export function VerifyForm() {
  const [godId, setGodId] = useState<string>("apollo");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [settleTxHash, setSettleTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem("verify-prefill");
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as {
        godId?: string;
        question?: string;
        answer?: string;
        settleTxHash?: string;
      };
      if (p.godId) setGodId(p.godId);
      if (p.question) setQuestion(p.question);
      if (p.answer) setAnswer(p.answer);
      if (p.settleTxHash) setSettleTxHash(p.settleTxHash);
      setPrefilled(true);
    } catch {
      // ignore malformed stash
    }
    sessionStorage.removeItem("verify-prefill");
  }, []);

  const ready =
    question.trim().length > 0 &&
    answer.trim().length > 0 &&
    /^[0-9a-fA-F]{64}$/.test(settleTxHash.trim());

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/verify-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          godId,
          question: question.trim(),
          answer: answer.trim(),
          settleTxHash: settleTxHash.trim(),
        }),
      });
      const body = (await res.json()) as VerifyResponse;
      if (!res.ok) {
        throw new Error(body.error ?? `verify failed (${res.status})`);
      }
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      {prefilled && (
        <p className="mb-4 rounded-sm border border-laurel/40 bg-laurel/[0.06] px-4 py-2 text-xs text-laurel">
          Prefilled from your petition run — press Verify.
        </p>
      )}

      <div className="space-y-4 rounded-sm border border-ink/15 bg-marble/60 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <label className="text-[10px] uppercase tracking-wider text-ink/50">
            God
          </label>
          <div className="flex gap-2">
            {GODS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGodId(g)}
                className={`rounded-full border px-3 py-1 text-[11px] capitalize transition ${
                  godId === g
                    ? "border-gold bg-gold/15 text-ink"
                    : "border-ink/15 text-ink/60 hover:border-gold hover:text-gold"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="v-question"
            className="text-[10px] uppercase tracking-wider text-ink/50"
          >
            Question — exactly as consulted
          </label>
          <textarea
            id="v-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-sm border border-ink/20 bg-marble px-3 py-2 text-sm outline-none focus:border-gold"
          />
        </div>

        <div>
          <label
            htmlFor="v-answer"
            className="text-[10px] uppercase tracking-wider text-ink/50"
          >
            Answer — the god&apos;s full reply, character for character
          </label>
          <textarea
            id="v-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
            className="mt-1 w-full resize-none rounded-sm border border-ink/20 bg-marble px-3 py-2 text-sm outline-none focus:border-gold"
          />
        </div>

        <div>
          <label
            htmlFor="v-tx"
            className="text-[10px] uppercase tracking-wider text-ink/50"
          >
            x402 settle tx hash (64 hex)
          </label>
          <input
            id="v-tx"
            value={settleTxHash}
            onChange={(e) => setSettleTxHash(e.target.value)}
            spellCheck={false}
            className="mt-1 w-full rounded-sm border border-ink/20 bg-marble px-3 py-2 font-mono text-xs outline-none focus:border-gold"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!ready || busy}
          className="rounded-sm border border-gold bg-gold/10 px-5 py-2 text-xs font-medium uppercase tracking-[0.2em] text-ink transition hover:bg-gold/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Recomputing…" : "Verify"}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-sm border border-amphora/40 bg-amphora/10 px-4 py-3 text-sm text-amphora">
          {error}
        </p>
      )}

      {result && (
        <div
          className={`mt-6 rounded-sm border p-5 ${
            result.verified
              ? "border-laurel/50 bg-laurel/[0.07]"
              : "border-amphora/50 bg-amphora/[0.07]"
          }`}
        >
          <p
            className={`text-lg font-medium ${
              result.verified ? "text-laurel" : "text-amphora"
            }`}
          >
            {result.verified ? "✓ Witnessed" : "✗ Not verified"}
          </p>
          <p className="mt-1 text-xs text-ink/60">
            {result.verified
              ? "The receipt hash recomputed from your four inputs matches an on-chain transfer from the petitioner to this god."
              : "No on-chain transfer carries this receipt's transfer id from the expected signer to this god. One of the inputs differs from what was committed."}
          </p>

          {result.expected && (
            <dl className="mt-4 space-y-1.5 font-mono text-[12px] text-ink/75">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink/45">keccak256</dt>
                <dd className="break-all">{shortHex(result.expected.receiptHashHex)}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink/45">transfer id</dt>
                <dd>{result.expected.transferId}</dd>
              </div>
              {result.match && (
                <>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">matched deploy</dt>
                    <dd>
                      <a
                        href={`${DEPLOY_URL}/${result.match.deployHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-laurel underline-offset-2 hover:underline"
                      >
                        {shortHex(result.match.deployHash)} ↗
                      </a>
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-ink/45">timestamp</dt>
                    <dd>{result.match.timestamp}</dd>
                  </div>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
