import type { Metadata } from "next";
import { PetitionConsole } from "./_console";

export const metadata: Metadata = {
  title: "Petition the Pantheon — a live agent-pays-agent consult",
  description:
    "Watch an autonomous AI petitioner pick a god by on-chain reputation, pay it via x402, and bring back a receipt anyone can verify.",
};

export default function PetitionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="border-b border-ink/10 pb-8">
        <p
          className="text-xs uppercase tracking-[0.3em] text-amphora"
          data-hero=""
        >
          The Petition
        </p>
        <h1
          className="mt-2 text-4xl font-light italic"
          style={{ fontFamily: "var(--font-display)" }}
          data-hero=""
        >
          Ask, and be witnessed.
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-ink/60" data-hero="">
          This runs a real autonomous agent, live. It reads the pantheon,
          weighs each god&apos;s on-chain Brier reputation, pays the chosen god
          a WCSPR tithe via x402 with its own Casper key, and returns the
          answer with an on-chain receipt. One petition per visitor per ten
          minutes; the temple&apos;s daily tithe budget is capped.
        </p>
      </header>
      <PetitionConsole />
    </main>
  );
}
