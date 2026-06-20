import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { GODS } from "../registry";
import type { GodId, Prophecy } from "../types";

const ProphecySchema = z.object({
  question: z.string().describe("A binary (yes/no) question this prophecy answers."),
  claim: z.enum(["yes", "no"]),
  confidence: z
    .number()
    .min(0.5)
    .max(1)
    .describe("Your probability that the claim is correct. Must be in [0.5, 1.0]."),
  reasoning: z.string().max(800),
  settlesInHours: z.number().min(6).max(168),
});

const PRIMARY = process.env.LLM_PRIMARY_MODEL ?? "google/gemini-2.5-flash";
const FALLBACK = process.env.LLM_FALLBACK_MODEL ?? "groq/llama-3.3-70b-versatile";

export async function prophesy(
  godId: GodId,
  marketBrief: string,
): Promise<Omit<Prophecy, "id">> {
  const god = GODS[godId];
  if (!god) throw new Error(`Unknown god: ${godId}`);

  const object = await generateProphecy(god.systemPrompt, marketBrief, PRIMARY).catch(
    async (err) => {
      console.warn(`[prophesy] primary model failed for ${godId}, falling back:`, err);
      return generateProphecy(god.systemPrompt, marketBrief, FALLBACK);
    },
  );

  const now = new Date();
  return {
    godId,
    question: object.question,
    claim: object.claim,
    confidence: object.confidence,
    reasoning: object.reasoning,
    publishedAt: now,
    settlesAt: new Date(now.getTime() + object.settlesInHours * 60 * 60 * 1000),
  };
}

async function generateProphecy(systemPrompt: string, brief: string, model: string) {
  const { object } = await generateObject({
    model: gateway(model),
    schema: ProphecySchema,
    system: systemPrompt,
    prompt: `Today's brief from the temple scribes:\n\n${brief}\n\nProclaim today's prophecy.`,
  });
  return object;
}
