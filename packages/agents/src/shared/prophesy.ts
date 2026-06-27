import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { GODS } from "../registry";
import {
  COMPARATORS,
  SETTLEMENT_FEEDS,
  type GodId,
  type Prophecy,
  type SettlementFeed,
} from "../types";

// Per-feed sanity bounds so a confused LLM can't emit threshold=1e100.
// These are intentionally wide; the prompt narrows the LLM further.
const FEED_BOUNDS: Record<SettlementFeed, { min: number; max: number }> = {
  BTC_USD: { min: 0, max: 1_000_000 },
  ETH_USD: { min: 0, max: 100_000 },
  USDC_USD: { min: 0.5, max: 1.5 },
  US10Y_RATE: { min: -5, max: 25 },
};

const ProphecySchema = z
  .object({
    question: z
      .string()
      .describe("A binary (yes/no) question this prophecy answers."),
    claim: z.enum(["yes", "no"]),
    confidence: z
      .number()
      .min(0.5)
      .max(1)
      .describe(
        "Your probability that the claim is correct. Must be in [0.5, 1.0].",
      ),
    reasoning: z.string().max(800),
    settlesInHours: z.number().min(6).max(168),
    settlement: z
      .object({
        feed: z.enum(SETTLEMENT_FEEDS),
        comparator: z.enum(COMPARATORS),
        threshold: z.number(),
      })
      .describe(
        "Mechanical settlement rule: at settles_at we fetch `feed`, evaluate " +
          "`feed.value <comparator> threshold`, and treat the boolean result " +
          "as the underlying truth. Your `claim` says yes/no on that condition.",
      ),
  })
  .superRefine((obj, ctx) => {
    const bounds = FEED_BOUNDS[obj.settlement.feed];
    if (
      obj.settlement.threshold < bounds.min ||
      obj.settlement.threshold > bounds.max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settlement", "threshold"],
        message: `threshold ${obj.settlement.threshold} outside sane bounds for ${obj.settlement.feed} [${bounds.min}, ${bounds.max}]`,
      });
    }
  });

const PRIMARY = process.env.LLM_PRIMARY_MODEL ?? "google/gemini-2.5-flash";
// Fallback must support structured outputs (json_schema). Anthropic Claude
// Haiku does via tool-use; Groq llama-3.3 does not.
const FALLBACK = process.env.LLM_FALLBACK_MODEL ?? "anthropic/claude-haiku-4-5";

export async function prophesy(
  godId: GodId,
  marketBrief: string,
): Promise<Omit<Prophecy, "id">> {
  const god = GODS[godId];
  if (!god) throw new Error(`Unknown god: ${godId}`);

  const allowedFeeds = god.allowedFeeds;
  const settlementInstructions = [
    `Your settlement.feed MUST be one of: ${allowedFeeds.join(", ")}.`,
    `Pick a threshold near current market values so the binary question is genuinely uncertain.`,
    `Your claim ("yes"/"no") and the settlement condition must be consistent — if you claim "yes",`,
    `you are betting that "feed.value <comparator> threshold" will be true at settles_at.`,
  ].join(" ");

  const object = await generateProphecy(
    god.systemPrompt,
    marketBrief,
    settlementInstructions,
    PRIMARY,
  ).catch(async (err) => {
    console.warn(
      `[prophesy] primary model failed for ${godId}, falling back:`,
      err,
    );
    return generateProphecy(
      god.systemPrompt,
      marketBrief,
      settlementInstructions,
      FALLBACK,
    );
  });

  if (!allowedFeeds.includes(object.settlement.feed)) {
    throw new Error(
      `${godId} returned disallowed feed ${object.settlement.feed} (allowed: ${allowedFeeds.join(", ")})`,
    );
  }

  const now = new Date();
  return {
    godId,
    question: object.question,
    claim: object.claim,
    confidence: object.confidence,
    reasoning: object.reasoning,
    publishedAt: now,
    settlesAt: new Date(now.getTime() + object.settlesInHours * 60 * 60 * 1000),
    settlement: object.settlement,
  };
}

async function generateProphecy(
  systemPrompt: string,
  brief: string,
  settlementInstructions: string,
  model: string,
) {
  const { object } = await generateObject({
    model: gateway(model),
    schema: ProphecySchema,
    system: `${systemPrompt}\n\n${settlementInstructions}`,
    prompt: `Today's brief from the temple scribes:\n\n${brief}\n\nProclaim today's prophecy.`,
  });
  return object;
}
