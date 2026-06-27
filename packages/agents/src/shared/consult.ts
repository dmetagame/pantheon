import { generateText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { GODS } from "../registry";
import type { GodId } from "../types";

const PRIMARY = process.env.LLM_PRIMARY_MODEL ?? "google/gemini-2.5-flash";
// Same fallback as prophesy.ts so the two paths stay aligned. consult uses
// generateText (no json_schema dependency) so any model would work here, but
// keeping them coherent avoids surprise if we ever swap the primary.
const FALLBACK = process.env.LLM_FALLBACK_MODEL ?? "anthropic/claude-haiku-4-5";

export async function consult(godId: GodId, petitionerQuestion: string): Promise<string> {
  const god = GODS[godId];
  if (!god) throw new Error(`Unknown god: ${godId}`);

  const system = `${god.systemPrompt}\n\nA petitioner has paid the offering and seeks your counsel. Answer briefly (under 200 words), in your voice, without breaking character.`;

  try {
    const { text } = await generateText({
      model: gateway(PRIMARY),
      system,
      prompt: petitionerQuestion,
    });
    return text;
  } catch (err) {
    console.warn(`[consult] primary model failed for ${godId}, falling back:`, err);
    const { text } = await generateText({
      model: gateway(FALLBACK),
      system,
      prompt: petitionerQuestion,
    });
    return text;
  }
}
