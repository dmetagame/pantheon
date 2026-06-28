// Structured logger. Emits one JSON-line per event for easy ingestion by
// Vercel's log scraper or any line-oriented log collector. Falls back to
// human-readable formatting when PANTHEON_PRETTY_LOGS is set (handy in
// local dev).

type Level = "debug" | "info" | "warn" | "error";

interface LogFields {
  [k: string]: unknown;
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  if (process.env.PANTHEON_PRETTY_LOGS) {
    const tag = level.toUpperCase().padEnd(5);
    const extra = fields ? " " + JSON.stringify(fields) : "";
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${msg}${extra}`);
    return;
  }
  // JSON line — Vercel log search treats this as a structured event.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
