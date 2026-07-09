import type { Metadata } from "next";
import { VerifyForm } from "./_form";

export const metadata: Metadata = {
  title: "Verify a consultation receipt — Pantheon",
  description:
    "Recompute a consult receipt hash and match it against the Casper chain without trusting Pantheon's database.",
};

export default function VerifyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="border-b border-ink/10 pb-8">
        <p
          className="text-xs uppercase tracking-[0.3em] text-amphora"
          data-hero=""
        >
          The Witness
        </p>
        <h1
          className="mt-2 text-4xl font-light italic"
          style={{ fontFamily: "var(--font-display)" }}
          data-hero=""
        >
          Verify the witness.
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-ink/60" data-hero="">
          Every consultation ends in a receipt: keccak256 of the god, the
          question, the answer, and the payment transaction. Its low bytes are
          carried as the transfer id of an on-chain memo. Paste the four inputs
          and this server-assisted verifier recomputes the hash and matches it
          against Casper without trusting Pantheon&apos;s database. If the answer
          had been altered by even one character, the hash would not match.
        </p>
      </header>
      <VerifyForm />
    </main>
  );
}
