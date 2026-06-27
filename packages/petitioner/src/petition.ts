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

const API_BASE = process.env.PANTHEON_API_URL ?? "http://localhost:3030";
const CONSULT_SECRET = process.env.PANTHEON_CONSULT_SECRET;
const MODEL = process.env.PETITIONER_MODEL ?? "anthropic/claude-haiku-4-5";

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
      "Ask a specific god a question. Returns the god's answer in their own voice. The endpoint follows the x402 payment-required pattern: without an authorised offering it returns a 402 with the canonical accepts envelope describing the required USDC tithe. With PANTHEON_CONSULT_SECRET set as bearer, the petitioner is authorised for the hackathon demo.",
    inputSchema: z.object({
      godId: z.enum(GOD_IDS),
      question: z
        .string()
        .min(1)
        .max(500)
        .describe("The question to ask. One sentence works best."),
    }),
    execute: async ({ godId, question }) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (CONSULT_SECRET) headers.Authorization = `Bearer ${CONSULT_SECRET}`;

      const res = await fetch(`${API_BASE}/api/consult/${godId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ question }),
      });

      if (res.status === 402) {
        const body = (await res.json()) as Record<string, unknown>;
        return {
          paymentRequired: true,
          x402Envelope: body,
          hint: "The temple demands an offering. Set PANTHEON_CONSULT_SECRET on the petitioner process to authorise.",
        };
      }
      if (!res.ok) {
        throw new Error(`consult ${godId}: ${res.status} ${await res.text()}`);
      }
      return await res.json();
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
