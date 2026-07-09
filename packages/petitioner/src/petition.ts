// The Petitioner — an autonomous AI agent that approaches the Pantheon to
// get a verifiable forecast.
//
// Usage (CLI):
//   pnpm --filter @pantheon/petitioner petition "Will BTC close above $62k today?"
//
// The agent uses three tools (list_pantheon, get_god, consult_god) wrapping
// the same HTTP surface @pantheon/mcp exposes over stdio. Claude orchestrates
// the decision: which god fits the question's domain, whose on-chain Brier
// reputation is highest, whether to consult that god.
//
// The core is event-driven: runPetition emits typed PetitionEvents as each
// agent turn completes, so the same engine drives both the CLI transcript
// (console printer below) and the website's streaming /api/petition route.

import { generateText, stepCountIs, tool } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import {
  loadSigner,
  signPaymentPayload,
  type AcceptsEnvelope,
} from "@pantheon/sdk";

const MODEL = process.env.PETITIONER_MODEL ?? "anthropic/claude-haiku-4-5";

const GOD_IDS = ["demeter", "hermes", "apollo"] as const;

export interface PetitionConfig {
  /** Base URL of the Pantheon HTTP API the tools call. */
  apiBase?: string;
  /** Sign + pay a real Casper x402 transfer on 402 responses. */
  x402?: boolean;
  /** Hackathon bearer fallback used when x402 is off. */
  consultSecret?: string;
  /** Hard cap on consult_god calls a single autonomous run may perform. */
  maxPaidConsults?: number;
  /** Receives every transcript event as it happens. */
  onEvent?: (e: PetitionEvent) => void;
}

export type PetitionEvent =
  | { type: "turn"; index: number; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; preview: string }
  | { type: "final"; text: string }
  | { type: "proof"; proof: ConsultOutcome };

function positiveInt(value: number | string | undefined, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : parseInt(value ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveConfig(cfg?: PetitionConfig): Required<PetitionConfig> {
  return {
    apiBase:
      cfg?.apiBase ?? process.env.PANTHEON_API_URL ?? "http://localhost:3030",
    x402: cfg?.x402 ?? process.env.PETITIONER_X402 === "1",
    consultSecret:
      cfg?.consultSecret ?? process.env.PANTHEON_CONSULT_SECRET ?? "",
    maxPaidConsults: positiveInt(
      cfg?.maxPaidConsults ?? process.env.PETITIONER_MAX_PAID_CONSULTS,
      1,
    ),
    onEvent: cfg?.onEvent ?? (() => {}),
  };
}

// ─── tools the petitioner can call ────────────────────────────────────────

function makeTools(cfg: Required<PetitionConfig>) {
  const { apiBase, x402, consultSecret, maxPaidConsults } = cfg;
  let consultCalls = 0;
  return {
    list_pantheon: tool({
      description:
        "List the AI gods of the Pantheon with their current on-chain reputation, settled vs pending prophecy counts, and 'last spoke' timestamp. Use this first to see who is available and how well-calibrated they are.",
      inputSchema: z.object({}),
      execute: async () => {
        const res = await fetch(`${apiBase}/api/scoreboard`);
        if (!res.ok) {
          throw new Error(`list_pantheon: ${res.status} from ${apiBase}`);
        }
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
        const res = await fetch(`${apiBase}/api/god/${godId}`);
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
        if (consultCalls >= maxPaidConsults) {
          const noun = maxPaidConsults === 1 ? "consult" : "consults";
          return {
            blocked: true,
            paid: false,
            hint: `This petitioner run is capped at ${maxPaidConsults} paid ${noun}. Pick one god and finish from the evidence already gathered.`,
          };
        }
        consultCalls += 1;

        const url = `${apiBase}/api/consult/${godId}`;
        const body = JSON.stringify({ question });

        // 1. First attempt — empty when x402 so we drive the real
        //    x402 round-trip; bearer otherwise so the hackathon demo still
        //    works when CEP18 token funding isn't yet in place.
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (!x402 && consultSecret) {
          headers.Authorization = `Bearer ${consultSecret}`;
        }

        const res = await fetch(url, { method: "POST", headers, body });
        if (res.status !== 402) {
          if (!res.ok) {
            throw new Error(
              `consult ${godId}: ${res.status} ${await res.text()}`,
            );
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

        if (!x402) {
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
}

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

// ─── transcript events ────────────────────────────────────────────────────

interface StepLike {
  text?: string;
  toolCalls?: Array<{ toolName: string; input?: unknown; args?: unknown }>;
  toolResults?: Array<{ toolName: string; output?: unknown; result?: unknown }>;
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function emitStep(
  step: StepLike,
  idx: number,
  onEvent: (e: PetitionEvent) => void,
): void {
  if (step.text) {
    onEvent({ type: "turn", index: idx, text: step.text });
  }
  for (const tc of step.toolCalls ?? []) {
    // The AI SDK v5 uses `input` for tool args; some versions still use `args`.
    const args = (tc.input ?? tc.args) as unknown;
    onEvent({
      type: "tool_call",
      name: tc.toolName,
      args: trim(JSON.stringify(args), 120),
    });
  }
  for (const tr of step.toolResults ?? []) {
    const out = (tr.output ?? tr.result) as unknown;
    const text = typeof out === "string" ? out : JSON.stringify(out);
    onEvent({
      type: "tool_result",
      name: tr.toolName,
      preview: trim(text, 240),
    });
  }
}

// ─── consult outcome extraction ──────────────────────────────────────────

export interface ConsultOutcome {
  god?: string;
  reputationBp?: number;
  paymentSettleTx?: string;
  paymentAmountMotes?: string;
  receiptTxHash?: string;
  receiptHashHex?: string;
  payer?: string;
  /** The exact question/answer pair — feeds the /verify page. */
  question?: string;
  answer?: string;
}

function scoreboardGods(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === "object") {
    const gods = (value as { gods?: unknown }).gods;
    if (Array.isArray(gods)) return gods as Array<Record<string, unknown>>;
  }
  return [];
}

function extractConsultOutcome(steps: StepLike[]): ConsultOutcome {
  const out: ConsultOutcome = {};
  let listedGods: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    for (const tc of step.toolCalls ?? []) {
      if (tc.toolName === "consult_god") {
        const args = (tc.input ?? tc.args) as
          | { question?: string }
          | undefined;
        if (args?.question) out.question = args.question;
      }
    }
    for (const tr of step.toolResults ?? []) {
      const r = (tr.output ?? tr.result) as Record<string, unknown> | undefined;
      if (!r) continue;
      if (tr.toolName === "consult_god" && typeof r.answer === "string") {
        out.god = String(r.god ?? "");
        out.answer = r.answer;
        if (typeof r.question === "string") out.question = r.question;
        const payment = r.payment as Record<string, unknown> | undefined;
        if (payment) {
          out.paymentSettleTx = String(payment.settleTx ?? "");
          out.paymentAmountMotes = String(payment.amount ?? "");
        }
        const receipt = r.receipt as Record<string, unknown> | undefined;
        if (receipt) {
          out.receiptTxHash = String(receipt.txHash ?? "");
          out.receiptHashHex = String(receipt.hashHex ?? "");
        }
        out.payer = (r.signedAs as string | undefined) ?? out.payer;
      }
      if (tr.toolName === "list_pantheon") {
        listedGods = scoreboardGods(r);
      }
    }
  }
  if (out.god) {
    const god = listedGods.find((g) => String(g.id ?? "") === out.god);
    if (god && god.reputationBp !== undefined) {
      out.reputationBp = Number(god.reputationBp);
    }
  }
  return out;
}

// ─── engine ───────────────────────────────────────────────────────────────

export async function runPetition(
  question: string,
  cfg?: PetitionConfig,
): Promise<{ final: string; outcome: ConsultOutcome }> {
  const resolved = resolveConfig(cfg);
  const { onEvent } = resolved;

  let emitted = 0;
  const { text, steps } = await generateText({
    model: gateway(MODEL),
    system: SYSTEM,
    prompt: question,
    tools: makeTools(resolved),
    // The agent should be done in 6–8 tool turns (list, maybe 1–2 get_god,
    // 1 consult, plus the final summary). Cap so a runaway loop fails loud.
    stopWhen: stepCountIs(8),
    onStepFinish: (step) => {
      emitStep(step as StepLike, emitted++, onEvent);
    },
  });

  onEvent({ type: "final", text });

  const outcome = extractConsultOutcome(steps as StepLike[]);
  if (outcome.paymentSettleTx || outcome.receiptTxHash) {
    onEvent({ type: "proof", proof: outcome });
  }

  return { final: text, outcome };
}

// ─── CLI printer ─────────────────────────────────────────────────────────

const EXPLORER_DEPLOY =
  process.env.CASPER_EXPLORER_TRANSACTION_URL ??
  "https://testnet.cspr.live/transaction";
const EXPLORER_ACCOUNT = "https://testnet.cspr.live/account";

function fmtMotes(motes: string | undefined, symbol = "WCSPR", decimals = 9): string {
  if (!motes) return "—";
  const v = BigInt(motes);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  const frac = v % d;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} ${symbol}` : `${whole} ${symbol}`;
}

function printEvent(e: PetitionEvent): void {
  switch (e.type) {
    case "turn":
      console.log(`\n┌── petitioner (turn ${e.index + 1}) ──`);
      console.log(e.text);
      console.log(`└──`);
      break;
    case "tool_call":
      console.log(`\n→ ${e.name}(${e.args})`);
      break;
    case "tool_result":
      console.log(`← ${e.name}: ${e.preview}`);
      break;
    case "final":
      console.log(`\n╔═══ Final Report ═══╗`);
      console.log(e.text);
      console.log(`╚════════════════════╝\n`);
      break;
    case "proof": {
      const p = e.proof;
      console.log(`╔═══ On-chain proof ═══╗`);
      if (p.god) console.log(`  God consulted     ${p.god}`);
      if (p.reputationBp !== undefined) {
        console.log(
          `  Trusted at        ${(p.reputationBp / 100).toFixed(2)}% on-chain reputation`,
        );
      }
      if (p.paymentSettleTx) {
        console.log(`  x402 settle       ${EXPLORER_DEPLOY}/${p.paymentSettleTx}`);
        if (p.paymentAmountMotes) {
          console.log(`    amount          ${fmtMotes(p.paymentAmountMotes)}`);
        }
      }
      if (p.receiptTxHash) {
        console.log(`  Receipt           ${EXPLORER_DEPLOY}/${p.receiptTxHash}`);
        if (p.receiptHashHex) {
          console.log(
            `    keccak256       ${p.receiptHashHex.slice(0, 16)}…${p.receiptHashHex.slice(-8)}`,
          );
        }
      }
      if (p.payer) console.log(`  Petitioner        ${EXPLORER_ACCOUNT}/${p.payer}`);
      console.log(`╚══════════════════════╝\n`);
      break;
    }
  }
}

async function cli(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("Usage: petition <question>");
    process.exit(1);
  }

  const cfg = resolveConfig();
  console.log(`\n╔══════ Pantheon Petitioner ══════╗`);
  console.log(`  Question: ${question}`);
  console.log(`  Model:    ${MODEL}`);
  console.log(`  API:      ${cfg.apiBase}`);
  console.log(
    `  Auth:     ${cfg.x402 ? "x402 (on-chain payment)" : cfg.consultSecret ? "bearer (demo)" : "none — expect 402"}`,
  );
  console.log(`╚═════════════════════════════════╝`);

  await runPetition(question, { onEvent: printEvent });
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
