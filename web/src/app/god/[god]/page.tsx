import { notFound } from "next/navigation";
import Link from "next/link";
import { GODS, type GodId } from "@pantheon/agents";
import {
  getGodDetail,
  prophecyStatus,
  type ProphecyRow,
} from "@/lib/god";
import type { GodStats } from "@/lib/scoreboard";
import {
  getRecentConsultations,
  type ConsultationRow,
} from "@/lib/consultations";
import { GOD_ACCENT, Sigil } from "../../_sigils";

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

const EXPLORER =
  process.env.NEXT_PUBLIC_CASPER_EXPLORER_TRANSACTION_URL ??
  "https://testnet.cspr.live/transaction";
const ACCOUNT_EXPLORER = "https://testnet.cspr.live/account";
const CASPER_TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const TOKEN_SYMBOL = process.env.X402_TOKEN_SYMBOL ?? "WCSPR";
const TOKEN_DECIMALS = parseInt(process.env.X402_TOKEN_DECIMALS ?? "9", 10);

function fmtTreasury(motes: string): string {
  if (!motes || motes === "0") return `0 ${TOKEN_SYMBOL}`;
  const big = BigInt(motes);
  const divisor = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = big / divisor;
  const frac = big % divisor;
  const fracStr = frac
    .toString()
    .padStart(TOKEN_DECIMALS, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return fracStr
    ? `${whole}.${fracStr} ${TOKEN_SYMBOL}`
    : `${whole} ${TOKEN_SYMBOL}`;
}

function shortPubkey(pk: string): string {
  return `${pk.slice(0, 10)}…${pk.slice(-6)}`;
}

function TreasuryStrip({
  stats,
  accentText,
}: {
  stats: GodStats;
  accentText: string;
}) {
  if (!stats.publicKey) return null;
  const chainUnavailable = stats.chainReputationBp === null;
  const matches = stats.reputationVerified;
  return (
    <div className="mt-6 flex flex-wrap items-baseline justify-between gap-3 rounded-sm border border-ink/10 bg-marble/50 px-4 py-3 text-xs">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-ink/50">
          Treasury (on-chain)
        </p>
        <p className={`mt-1 text-base font-medium tabular-nums ${accentText}`}>
          {fmtTreasury(stats.treasuryMotes)}
        </p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-ink/50">
          Consult price
        </p>
        <p
          className={`mt-1 text-base font-medium tabular-nums ${accentText}`}
          title="Linearly scaled by reputation. New oracles are cheap; calibrated oracles cost more."
        >
          {fmtTreasury(stats.consultPriceMotes)}
        </p>
      </div>
      <div>
        <p className="text-[10px] uppercase tracking-wider text-ink/50">
          DB ⇄ chain
        </p>
        <p
          className={`mt-1 text-base font-medium tabular-nums ${matches ? "text-laurel" : "text-amphora"}`}
          title={
            chainUnavailable
              ? "Chain reputation read is temporarily unavailable; displaying DB EWMA fallback until the node responds."
              : matches
              ? "Off-chain EWMA equals on-chain reputation_bp(godId) — independent computations agree."
              : `Off-chain EWMA = ${(stats.dbReputationBp / 100).toFixed(2)}% vs on-chain ${((stats.chainReputationBp ?? 0) / 100).toFixed(2)}% — operational state and contract state disagree.`
          }
        >
          {chainUnavailable
            ? "chain pending"
            : matches
              ? "✓ match"
              : `Δ ${((stats.dbReputationBp - (stats.chainReputationBp ?? 0)) / 100).toFixed(2)}%`}
        </p>
      </div>
      <a
        href={`${ACCOUNT_EXPLORER}/${stats.publicKey}`}
        target="_blank"
        rel="noreferrer"
        className="text-[10px] text-ink/50 hover:text-gold"
      >
        {shortPubkey(stats.publicKey)} ↗
      </a>
    </div>
  );
}

function ProphecyCard({ p }: { p: ProphecyRow }) {
  const status = prophecyStatus(p);
  const settled = !!p.settled_at;
  const legacy = status.tone === "legacy";
  return (
    <article className="rounded-sm border border-ink/15 bg-marble/70 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-wider text-laurel">
          {p.settlement_feed ?? "Legacy"}{" "}
          <span className="text-ink/40">
            {legacy
              ? "no settlement spec"
              : `${p.settlement_comparator ?? ""} ${fmtThreshold(p.settlement_feed, p.settlement_threshold)}`}
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
          label={settled ? "Settled" : legacy ? "Expired" : "Settles"}
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

      {(p.tx_hash ||
        p.propose_tx_hash ||
        p.approve_tx_hash ||
        p.settle_tx_hash ||
        p.reputation_tx_hash) && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink/40">
          {p.tx_hash && (
            <TxLink label="publish (god)" hash={p.tx_hash} />
          )}
          {p.propose_tx_hash && (
            <TxLink label="propose (god)" hash={p.propose_tx_hash} />
          )}
          {p.approve_tx_hash && (
            <TxLink label="approve (priest)" hash={p.approve_tx_hash} />
          )}
          {p.settle_tx_hash && (
            <TxLink label="settle" hash={p.settle_tx_hash} />
          )}
          {p.reputation_tx_hash && (
            <TxLink label="reputation" hash={p.reputation_tx_hash} />
          )}
          {p.quorum_proposal_id && (
            <span className="text-ink/30">
              quorum #{p.quorum_proposal_id}
            </span>
          )}
        </p>
      )}
    </article>
  );
}

function ConsultationCard({ c }: { c: ConsultationRow }) {
  const verified = !!c.receipt_tx_hash;
  const refunded = !!c.refund_tx_hash && c.refund_amount;
  return (
    <article
      className={`rounded-sm border p-5 ${refunded ? "border-amphora/40 bg-amphora/[0.03]" : "border-ink/15 bg-marble/70"}`}
    >
      <p
        className="text-lg italic leading-snug"
        style={{ fontFamily: "var(--font-display)" }}
      >
        “{c.question}”
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">{c.answer}</p>
      <p className="mt-3 text-[11px] text-ink/40">
        {fmtRelative(new Date(c.created_at))}
        {c.petitioner && (
          <>
            {" "}· petitioner{" "}
            <span className="font-mono">{short(c.petitioner)}</span>
          </>
        )}
      </p>
      {refunded && (
        <p className="mt-3 rounded-sm border border-amphora/30 bg-amphora/5 px-3 py-2 text-[11px] text-amphora">
          Bond slashed — prophecy #{c.refund_prophecy_id} broke. Refunded{" "}
          <span className="font-medium tabular-nums">
            {fmtTreasury(c.refund_amount!)}
          </span>{" "}
          to petitioner.
        </p>
      )}
      {(c.payment_tx_hash || c.receipt_tx_hash || c.refund_tx_hash) && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink/40">
          {c.payment_tx_hash && (
            <TxLink label="x402 settle" hash={c.payment_tx_hash} />
          )}
          {c.receipt_tx_hash && (
            <TxLink label="receipt" hash={c.receipt_tx_hash} />
          )}
          {c.refund_tx_hash && (
            <TxLink label="refund" hash={c.refund_tx_hash} />
          )}
          {verified && (
            <span
              className="rounded-full border border-laurel/40 bg-laurel/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-laurel"
              title={
                c.receipt_id_hex
                  ? `keccak256(godId|question|answer|settleTx) = ${c.receipt_id_hex}`
                  : ""
              }
            >
              Receipt on chain
            </span>
          )}
        </p>
      )}
    </article>
  );
}

function TxLink({ label, hash }: { label: string; hash: string }) {
  if (!CASPER_TX_HASH_RE.test(hash)) return null;
  return (
    <a
      href={`${EXPLORER}/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="hover:text-gold"
    >
      {label}: {short(hash)} ↗
    </a>
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
  tone: "pending" | "fulfilled" | "broken" | "unconfirmed" | "legacy";
  label: string;
}) {
  const styles: Record<typeof tone, string> = {
    fulfilled: "border-laurel/40 text-laurel bg-laurel/5",
    broken: "border-amphora/50 text-amphora bg-amphora/5",
    pending: "border-ink/20 text-ink/60 bg-ink/[0.02]",
    unconfirmed: "border-ink/15 text-ink/40 bg-ink/[0.02]",
    legacy: "border-ink/15 text-ink/40 bg-ink/[0.02]",
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
  const accent = GOD_ACCENT[stats.id];
  const consultations = await getRecentConsultations(stats.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link
        href="/"
        className="text-xs uppercase tracking-[0.3em] text-ink/50 hover:text-gold"
      >
        ← Pantheon
      </Link>

      <header className="mt-8 border-b border-ink/10 pb-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p
              className={`text-xs uppercase tracking-[0.3em] ${accent.text}`}
              data-hero=""
            >
              {meta.title}
            </p>
            <h1
              className="mt-2 text-6xl font-light italic"
              style={{ fontFamily: "var(--font-display)" }}
              data-hero=""
            >
              {meta.name}
            </h1>
          </div>
          <span className="shrink-0" data-hero="">
            <Sigil
              godId={stats.id}
              className={`size-16 ${accent.text} opacity-80`}
            />
          </span>
        </div>
        <p className="mt-4 max-w-2xl text-ink/70" data-hero="">
          {meta.domain}
        </p>
        <p className="mt-2 max-w-2xl text-sm italic text-ink/50" data-hero="">
          {voice}
        </p>

        <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-ink/10 pt-6 sm:grid-cols-5">
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
            label="Legacy"
            value={stats.prophecies_legacy_blocked.toString()}
            mono
          />
          <Field
            label="Domain feeds"
            value={allowedFeeds.join(" · ")}
          />
        </dl>

        <TreasuryStrip
          stats={stats}
          accentText={accent.text}
        />
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

      {consultations.length > 0 && (
        <section className="mt-16">
          <h2 className="text-xs uppercase tracking-[0.3em] text-amphora">
            The Consultations
          </h2>
          <p className="mt-2 text-xs text-ink/50">
            Petitioners&apos; questions answered, each bound to an on-chain
            receipt from the configured receipt signer for this payment.
          </p>
          <ul className="mt-6 grid gap-4">
            {consultations.map((c) => (
              <li key={c.id}>
                <ConsultationCard c={c} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-24 border-t border-ink/10 pt-6 text-xs text-ink/50">
        On-chain links resolve to testnet.cspr.live. Reputation = 100 − EWMA
        Brier across settled prophecies.
      </footer>
    </main>
  );
}
