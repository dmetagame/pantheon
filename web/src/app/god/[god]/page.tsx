import { notFound } from "next/navigation";
import Link from "next/link";
import { GODS, type GodId } from "@pantheon/agents";
import {
  getGodDetail,
  prophecyStatus,
  type ProphecyRow,
} from "@/lib/god";

export const dynamic = "force-dynamic";

const VALID: GodId[] = ["demeter", "hermes", "apollo"];

function reputationPct(bp: number): string {
  return (bp / 100).toFixed(1);
}

function fmtConfidence(bp: number): string {
  return `${(bp / 100).toFixed(0)}%`;
}

function fmtThreshold(feed: string | null, threshold: string | null): string {
  if (threshold == null) return "—";
  const n = Number(threshold);
  if (feed === "US10Y_RATE") return `${n.toFixed(2)}%`;
  if (feed === "USDC_USD") return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtRelative(d: Date): string {
  const ms = Date.now() - new Date(d).getTime();
  const future = ms < 0;
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60_000);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  const body =
    days >= 1 ? `${days}d` : h >= 1 ? `${h}h` : m >= 1 ? `${m}m` : "<1m";
  return future ? `in ${body}` : `${body} ago`;
}

const EXPLORER = "https://cspr.live/deploy";

function ProphecyCard({ p }: { p: ProphecyRow }) {
  const status = prophecyStatus(p);
  const settled = !!p.settled_at;
  return (
    <article className="rounded-sm border border-ink/15 bg-marble/70 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-wider text-laurel">
          {p.settlement_feed ?? "—"}{" "}
          <span className="text-ink/40">
            {p.settlement_comparator ?? ""}{" "}
            {fmtThreshold(p.settlement_feed, p.settlement_threshold)}
          </span>
        </p>
        <StatusPill tone={status.tone} label={status.label} />
      </header>

      <p
        className="mt-3 text-lg italic leading-snug"
        style={{ fontFamily: "var(--font-display)" }}
      >
        “{p.question}”
      </p>

      <p className="mt-3 text-sm text-ink/70 leading-relaxed">{p.reasoning}</p>

      <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-ink/10 pt-4 text-xs sm:grid-cols-4">
        <Field
          label="Claim"
          value={p.claim ? "YES" : "NO"}
          mono
        />
        <Field
          label="Confidence"
          value={fmtConfidence(p.confidence_bp)}
          mono
        />
        <Field
          label="Published"
          value={fmtRelative(p.published_at)}
        />
        <Field
          label={settled ? "Settled" : "Settles"}
          value={fmtRelative(settled ? p.settled_at! : p.settles_at)}
        />
      </dl>

      {settled && p.brier_bp !== null && (
        <p className="mt-3 text-xs text-ink/60">
          Truth:{" "}
          <span className="font-medium text-ink/80">
            {p.truth ? "YES" : "NO"}
          </span>{" "}
          · Brier:{" "}
          <span className="font-medium tabular-nums text-ink/80">
            {(p.brier_bp / 100).toFixed(1)}
          </span>
          {p.source_value && (
            <span className="text-ink/40"> · {p.source_value}</span>
          )}
        </p>
      )}

      {(p.tx_hash || p.settle_tx_hash) && (
        <p className="mt-3 flex gap-3 text-[11px] text-ink/40">
          {p.tx_hash && (
            <a
              href={`${EXPLORER}/${p.tx_hash}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-gold"
            >
              publish: {short(p.tx_hash)} ↗
            </a>
          )}
          {p.settle_tx_hash && (
            <a
              href={`${EXPLORER}/${p.settle_tx_hash}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-gold"
            >
              settle: {short(p.settle_tx_hash)} ↗
            </a>
          )}
        </p>
      )}
    </article>
  );
}

function short(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-ink/50">{label}</dt>
      <dd className={`font-medium ${mono ? "tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "pending" | "fulfilled" | "broken" | "unconfirmed";
  label: string;
}) {
  const styles: Record<typeof tone, string> = {
    fulfilled: "border-laurel/40 text-laurel bg-laurel/5",
    broken: "border-amphora/50 text-amphora bg-amphora/5",
    pending: "border-ink/20 text-ink/60 bg-ink/[0.02]",
    unconfirmed: "border-ink/15 text-ink/40 bg-ink/[0.02]",
  };
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wider ${styles[tone]}`}
    >
      {label}
    </span>
  );
}

export default async function GodPage({
  params,
}: {
  params: Promise<{ god: string }>;
}) {
  const { god } = await params;
  if (!VALID.includes(god as GodId)) notFound();
  const detail = await getGodDetail(god as GodId);
  if (!detail) notFound();

  const { stats, voice, allowedFeeds, recent } = detail;
  const meta = GODS[stats.id];

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href="/"
        className="text-xs uppercase tracking-[0.3em] text-ink/50 hover:text-gold"
      >
        ← Pantheon
      </Link>

      <header className="mt-8 border-b border-ink/10 pb-10">
        <p className="text-xs uppercase tracking-[0.3em] text-amphora">
          {meta.title}
        </p>
        <h1
          className="mt-2 text-6xl font-light italic"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {meta.name}
        </h1>
        <p className="mt-4 max-w-2xl text-ink/70">{meta.domain}</p>
        <p className="mt-2 max-w-2xl text-sm italic text-ink/50">{voice}</p>

        <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-ink/10 pt-6 sm:grid-cols-4">
          <Field
            label="Reputation"
            value={
              stats.prophecies_settled === 0
                ? "—"
                : `${reputationPct(stats.reputationBp)}%`
            }
            mono
          />
          <Field
            label="Settled"
            value={stats.prophecies_settled.toString()}
            mono
          />
          <Field
            label="Pending"
            value={stats.prophecies_pending.toString()}
            mono
          />
          <Field
            label="Domain feeds"
            value={allowedFeeds.join(" · ")}
          />
        </dl>
      </header>

      <section className="mt-12">
        <h2 className="text-xs uppercase tracking-[0.3em] text-amphora">
          The Revelations
        </h2>
        {recent.length === 0 ? (
          <p className="mt-6 text-ink/50">No prophecies yet. The temple is silent.</p>
        ) : (
          <ul className="mt-6 grid gap-4">
            {recent.map((p) => (
              <li key={p.id}>
                <ProphecyCard p={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-24 border-t border-ink/10 pt-6 text-xs text-ink/50">
        On-chain links resolve to cspr.live. Reputation = 100 − mean Brier across
        settled prophecies.
      </footer>
    </main>
  );
}
