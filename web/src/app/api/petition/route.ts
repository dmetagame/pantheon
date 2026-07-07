// Public, rate-limited petition runner. Runs the same autonomous petitioner
// agent the CLI uses (list gods → inspect track record → pay via x402 →
// report) server-side, streaming the transcript to the browser as NDJSON —
// one JSON event per line, in the order the agent produces them.
//
// Spend controls: each successful run costs the petitioner wallet a real
// WCSPR consult fee, so the route is deliberately stingy:
//   - per-IP: 1 run per 10 minutes (in-memory token bucket)
//   - global: PETITION_DAILY_CAP consultations per rolling 24h (DB-counted,
//     so it holds across serverless instances)

import { runPetition, type PetitionEvent } from "@pantheon/petitioner";
import sql from "@/lib/db";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_IP_WINDOW_MS = 10 * 60 * 1000;
const DAILY_CAP = parseInt(process.env.PETITION_DAILY_CAP ?? "25", 10);
const MIN_QUESTION = 8;
const MAX_QUESTION = 300;

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}

export async function POST(req: Request) {
  const ip = clientIp(req);

  const rl = rateLimit(`petition:${ip}`, {
    capacity: 1,
    windowMs: PER_IP_WINDOW_MS,
  });
  if (!rl.ok) {
    return Response.json(
      {
        error: "One petition per 10 minutes — the temple values patience.",
        retryAfterSeconds: Math.ceil(rl.resetMs / 1000),
      },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } },
    );
  }

  // Global daily spend cap, counted from the DB so it survives instance
  // churn. Every successful petition writes one consultations row.
  const [{ n }] = (await sql`
    SELECT COUNT(*)::int AS n
    FROM consultations
    WHERE created_at > NOW() - INTERVAL '24 hours';
  `) as unknown as Array<{ n: number }>;
  if (n >= DAILY_CAP) {
    return Response.json(
      {
        error:
          "The pantheon's daily tithe budget is spent. Return tomorrow — or run the CLI petitioner with your own key.",
      },
      { status: 429 },
    );
  }

  let question: string;
  try {
    const body = (await req.json()) as { question?: string };
    question = (body.question ?? "").trim();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (question.length < MIN_QUESTION || question.length > MAX_QUESTION) {
    return Response.json(
      { error: `question must be ${MIN_QUESTION}–${MAX_QUESTION} characters` },
      { status: 400 },
    );
  }

  // The agent's tools call back into this same deployment. The request's
  // own origin is the only base that's correct in every environment
  // (localhost, preview, prod); PETITION_API_URL exists as an escape hatch.
  const apiBase =
    process.env.PETITION_API_URL ?? new URL(req.url).origin;

  log.info("petition.start", { ip, question: question.slice(0, 120) });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: PetitionEvent | { type: "done" } | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };
      try {
        await runPetition(question, {
          apiBase,
          x402: process.env.PETITION_WEB_X402 !== "0",
          onEvent: send,
        });
        send({ type: "done" });
        log.info("petition.done", { ip });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.warn("petition.failed", { ip, error: message });
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
