// The Petitioner — an autonomous AI agent that approaches the Pantheon to
// get a verifiable forecast.
//
// Usage:
//   pnpm --filter @pantheon/petitioner petition "Will BTC close above $62k today?"
//
// The agent uses three tools (list_pantheon, get_god, consult_god) wrapping
// the same HTTP surface @pantheon/mcp exposes over stdio. Claude orchestrates
// the decision: which god fits the question's domain, whose on-chain Brier
// reputation is highest, whether to consult that god. The transcript prints
// to stdout suitable for a demo recording.

import { generateText, stepCountIs, tool } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import {
  loadSigner,
  signPaymentPayload,
  type AcceptsEnvelope,
} from "@pantheon/sdk";

const API_BASE = process.env.PANTHEON_API_URL ?? "http://localhost:3030";
const CONSULT_SECRET = process.env.PANTHEON_CONSULT_SECRET;
const MODEL = process.env.PETITIONER_MODEL ?? "anthropic/claude-haiku-4-5";

// If true, the petitioner attempts to sign + pay via real Casper x402 on a
// 402 response. Off by default until CEP18 token funding is resolved; the
// petitioner falls back to the demo bearer.
const X402_ENABLED = process.env.PETITIONER_X402 === "1";

const GOD_IDS = ["demeter", "hermes", "apollo"] as const;

// ─── tools the petitioner can call ────────────────────────────────────────

const tools = {
  list_pantheon: tool({
    description:
      "List the AI gods of the Pantheon with their current on-chain reputation, settled vs pending prophecy counts, and 'last spoke' timestamp. Use this first to see who is available and how well-calibrated they are.",
    inputSchema: z.object({}),
    execute: async () => {
      const res = await fetch(`${API_BASE}/api/scoreboard`);
      if (!res.ok) throw new Error(`list_pantheon: ${res.status}`);
      return await res.json();
    },
  }),

  get_god: tool({
    description:
      "Get a single god's full profile — voice, allowed settlement feeds, and the 20 most recent prophecies with on-chain ids, the settlement spec each was sealed with, and Brier scores where already settled. Use this to evaluate a god's track record before consulting.",
    inputSchema: z.object({
      godId: z.enum(GOD_IDS).describe("Which god to fetch."),
    }),
    execute: async ({ godId }) => {
      const res = await fetch(`${API_BASE}/api/god/${godId}`);
      if (!res.ok) throw new Error(`get_god ${godId}: ${res.status}`);
      return await res.json();
    },
  }),

  consult_god: tool({
    description:
      "Ask a specific god a question. Returns the god's answer in their own voice. The endpoint follows the x402 payment-required pattern: the first request returns a 402 with a canonical accepts envelope describing the required CEP18 tithe; the petitioner then signs a TransferAuthorization with its own Casper key and retries with the X-Payment header. PANTHEON_CONSULT_SECRET as bearer is a hackathon fallback when CEP18 token funding hasn't been set up.",
    inputSchema: z.object({
      godId: z.enum(GOD_IDS),
      question: z
        .string()
        .min(1)
        .max(500)
        .describe("The question to ask. One sentence works best."),
    }),
    execute: async ({ godId, question }) => {
      const url = `${API_BASE}/api/consult/${godId}`;
      const body = JSON.stringify({ question });

      // 1. First attempt — empty when X402_ENABLED so we drive the real
      //    x402 round-trip; bearer otherwise so the hackathon demo still
      //    works when CEP18 token funding isn't yet in place.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (!X402_ENABLED && CONSULT_SECRET) {
        headers.Authorization = `Bearer ${CONSULT_SECRET}`;
      }

      const res = await fetch(url, { method: "POST", headers, body });
      if (res.status !== 402) {
        if (!res.ok) {
          throw new Error(`consult ${godId}: ${res.status} ${await res.text()}`);
        }
        return await res.json();
      }

      // 2. Got a 402 — parse the accepts envelope.
      const envelope = (await res.json()) as AcceptsEnvelope;
      const requirement = envelope.accepts?.[0];
      if (!requirement) {
        return {
          paymentRequired: true,
          x402Envelope: envelope,
          hint: "Server returned a 402 with no accepts entry — cannot pay.",
        };
      }

      if (!X402_ENABLED) {
        return {
          paymentRequired: true,
          x402Envelope: envelope,
          hint: "The temple demands an offering. PETITIONER_X402=1 enables on-chain payment via @casper-ecosystem/casper-eip-712; PANTHEON_CONSULT_SECRET enables the hackathon-stage bearer fallback.",
        };
      }

      // 3. Sign the TransferAuthorization with the petitioner's Casper key
      //    and retry with the X-Payment header. The signature digest is the
      //    EIP-712 typed-data hash over the auth fields under a domain that
      //    pins the network + token. The Casper Facilitator's /verify and
      //    /settle endpoints reconstruct the same digest server-side.
      let xPayment: string;
      let signedPayer: string;
      try {
        const signer = loadSigner("petitioner");
        const signed = await signPaymentPayload({
          signerKey: signer,
          recipient: requirement.payTo,
          amount: requirement.amount,
          paymentRequirements: requirement,
          resourceUrl: requirement.resource ?? url,
        });
        xPayment = signed.header;
        signedPayer = signer.publicKey.accountHash().toHex();
      } catch (e) {
        return {
          paymentRequired: true,
          x402Envelope: envelope,
          signingError: e instanceof Error ? e.message : String(e),
        };
      }

      const retry = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": xPayment,
        },
        body,
      });
      if (!retry.ok) {
        const text = await retry.text();
        return {
          paymentRequired: true,
          paid: false,
          retryStatus: retry.status,
          retryBody: text.slice(0, 600),
          signedAs: signedPayer,
          paidTo: requirement.payTo,
        };
      }
      const result = await retry.json();
      return { ...result, paid: true, signedAs: signedPayer };
    },
  }),
};

// ─── system prompt ────────────────────────────────────────────────────────

const SYSTEM = `You are a Pantheon petitioner — an autonomous AI agent that pays the
Pantheon, a marketplace of calibrated AI oracles on the Casper blockchain, for
verifiable forecasts on binary questions.

When the user asks you something, your workflow is:

1. Call list_pantheon to see who is available and their current on-chain
   reputation, settled prophecy counts, and recency.
2. Call get_god on the one or two most-promising candidates to inspect their
   domain (allowed price feeds), their voice, and their Brier-score track
   record on recent prophecies.
3. Pick the god whose domain best matches the question AND whose reputation
   gives you the most confidence. State your reasoning out loud — cite their
   numeric reputation and the relevant track record.
4. Consult that god with consult_god.
5. Report back to the user with: which god you chose, your reasoning, the
   god's answer, and a one-line note about the on-chain reputation you
   trusted.

Be specific, not abstract. Treat this like a public transcript someone is
watching: narrate trade-offs in concrete numbers ("Hermes' 88.8% vs
Apollo's 96.5%"). Don't be sycophantic. Don't hedge with disclaimers — the
gods carry their own confidence in the answer, that's the whole point of
calibrated reputation.

Each god has a domain:
- Demeter: stablecoin peg & chain health (Pyth USDC/USD, chain heartbeat)
- Hermes: short-term crypto prices (Pyth BTC/USD, ETH/USD)
- Apollo: macro & RWA (Pyth US10Y rate, BTC/USD as macro pulse)

If the question doesn't fit any god's domain, say so and don't force a
consult.`;

// ─── transcript printer ───────────────────────────────────────────────────

interface StepLike {
  text?: string;
  toolCalls?: Array<{ toolName: string; input?: unknown; args?: unknown }>;
  toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }>;
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function printStep(step: StepLike, idx: number): void {
  if (step.text) {
    console.log(`\n┌── petitioner (turn ${idx + 1}) ──`);
    console.log(step.text);
    console.log(`└──`);
  }
  for (const tc of step.toolCalls ?? []) {
    // The AI SDK v5 uses `input` for tool args; some versions still use `args`.
    const args = (tc.input ?? tc.args) as unknown;
    console.log(`\n→ ${tc.toolName}(${trim(JSON.stringify(args), 120)})`);
  }
  for (const tr of step.toolResults ?? []) {
    const out = (tr.output ?? tr.result) as unknown;
    const text = typeof out === "string" ? out : JSON.stringify(out);
    console.log(`← ${tr.toolName}: ${trim(text, 240)}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────

export async function runPetition(question: string): Promise<{ final: string }> {
  const { text, steps } = await generateText({
    model: gateway(MODEL),
    system: SYSTEM,
    prompt: question,
    tools,
    // The agent should be done in 6–8 tool turns (list, maybe 1–2 get_god,
    // 1 consult, plus the final summary). Cap so a runaway loop fails loud.
    stopWhen: stepCountIs(8),
  });

  for (let i = 0; i < steps.length; i++) {
    printStep(steps[i] as StepLike, i);
  }
  console.log(`\n╔═══ Final Report ═══╗`);
  console.log(text);
  console.log(`╚════════════════════╝\n`);

  return { final: text };
}

async function cli(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("Usage: petition <question>");
    process.exit(1);
  }

  console.log(`\n╔══════ Pantheon Petitioner ══════╗`);
  console.log(`  Question: ${question}`);
  console.log(`  Model:    ${MODEL}`);
  console.log(`  API:      ${API_BASE}`);
  console.log(`  Auth:     ${CONSULT_SECRET ? "bearer (demo)" : "none — expect 402"}`);
  console.log(`╚═════════════════════════════════╝`);

  await runPetition(question);
}

const isDirectInvocation = (() => {
  // tsx / esm: import.meta.url ends with the entry file.
  const ent = process.argv[1];
  return ent ? ent.endsWith("petition.ts") || ent.endsWith("petition.js") : false;
})();
if (isDirectInvocation) {
  cli().catch((e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
