// Public, rate-limited petition runner. Runs the same autonomous petitioner
// agent the CLI uses (list gods → inspect track record → pay via x402 →
// report) server-side, streaming the transcript to the browser as NDJSON —
// one JSON event per line, in the order the agent produces them.
//
// Spend controls: each successful run costs the petitioner wallet a real
// WCSPR consult fee, so the route is deliberately stingy:
//   - validate first, then per-IP: 1 run per 10 minutes (in-memory friction)
//   - global: PETITION_DAILY_CAP public runs per rolling 24h, reserved under
//     a Postgres advisory lock before any LLM/x402 work starts

import { runPetition, type PetitionEvent } from "@pantheon/petitioner";
import sql from "@/lib/db";
import { log } from "@/lib/log";
import { clientId, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_IP_WINDOW_MS = 10 * 60 * 1000;
const DAILY_CAP = positiveInt(process.env.PETITION_DAILY_CAP, 25);
const MIN_QUESTION = 8;
const MAX_QUESTION = 300;
const DAILY_CAP_LOCK = "pantheon_petition_daily_cap";

let schemaPromise: Promise<void> | null = null;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensurePetitionRunsSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS petition_runs (
          id BIGSERIAL PRIMARY KEY,
          client_id TEXT NOT NULL,
          question TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'reserved'
            CHECK (status IN ('reserved', 'completed', 'failed')),
          consult_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS petition_runs_recent_idx
          ON petition_runs (created_at);
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS petition_runs_client_recent_idx
          ON petition_runs (client_id, created_at);
      `;
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

async function reservePetitionRun(
  client: string,
  question: string,
): Promise<number | null> {
  await ensurePetitionRunsSchema();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${DAILY_CAP_LOCK}))`;
    const [{ n }] = (await tx`
      SELECT COUNT(*)::int AS n
      FROM petition_runs
      WHERE created_at > NOW() - INTERVAL '24 hours';
    `) as unknown as Array<{ n: number }>;
    if (n >= DAILY_CAP) return null;

    const [row] = (await tx`
      INSERT INTO petition_runs (client_id, question)
      VALUES (${client}, ${question})
      RETURNING id;
    `) as unknown as Array<{ id: string | number }>;
    return Number(row.id);
  });
}

async function finishPetitionRun(
  id: number,
  status: "completed" | "failed",
  consultCount: number,
  error?: string,
): Promise<void> {
  await sql`
    UPDATE petition_runs
    SET status = ${status},
        consult_count = ${consultCount},
        error = ${error ? error.slice(0, 1_000) : null},
        completed_at = NOW()
    WHERE id = ${id};
  `;
}

export async function POST(req: Request) {
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

  const client = clientId(req);
  const rl = rateLimit(`petition:${client}`, {
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

  let runId: number | null;
  try {
    runId = await reservePetitionRun(client, question);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("petition.reserve_failed", { client, error: message });
    return Response.json(
      { error: "petition reservation failed; try again shortly" },
      { status: 503 },
    );
  }
  if (runId === null) {
    return Response.json(
      {
        error:
          "The pantheon's daily tithe budget is spent. Return tomorrow — or run the CLI petitioner with your own key.",
      },
      { status: 429 },
    );
  }

  // The agent's tools call back into this same deployment. The request's
  // own origin is the only base that's correct in every environment
  // (localhost, preview, prod); PETITION_API_URL exists as an escape hatch.
  const apiBase =
    process.env.PETITION_API_URL ?? new URL(req.url).origin;

  log.info("petition.start", { client, runId, question: question.slice(0, 120) });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: PetitionEvent | { type: "done" } | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };
      try {
        const result = await runPetition(question, {
          apiBase,
          x402: process.env.PETITION_WEB_X402 !== "0",
          maxPaidConsults: 1,
          onEvent: send,
        });
        const consulted = result.outcome.god ? 1 : 0;
        await finishPetitionRun(runId, "completed", consulted).catch((err) => {
          log.error("petition.finish_failed", {
            client,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        send({ type: "done" });
        log.info("petition.done", { client, runId, consulted });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await finishPetitionRun(runId, "failed", 0, message).catch((err) => {
          log.error("petition.finish_failed", {
            client,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        log.warn("petition.failed", { client, runId, error: message });
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
