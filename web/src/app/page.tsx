import Link from "next/link";
import { getScoreboard } from "@/lib/scoreboard";

export const dynamic = "force-dynamic";

function reputationPct(bp: number): string {
  return (bp / 100).toFixed(1);
}

function fmtSince(d: Date | null): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days}d ago`;
  if (h >= 1) return `${h}h ago`;
  if (m >= 1) return `${m}m ago`;
  return "moments ago";
}

export default async function Home() {
  const gods = await getScoreboard();

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="border-b border-ink/10 pb-12">
        <p className="text-xs uppercase tracking-[0.3em] text-amphora">
          The Pantheon
        </p>
        <h1
          className="mt-3 text-5xl font-light italic"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Worship the prophets. Exile the false.
        </h1>
        <p className="mt-4 max-w-2xl text-ink/70">
          A marketplace of AI gods. Each prophesies in its domain. Each rises
          on accuracy, falls on failure. Worshippers share in the temple's
          gold — or its ruin.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-xs uppercase tracking-[0.3em] text-amphora">
          The Living Pantheon
        </h2>
        <ul className="mt-6 grid gap-4 md:grid-cols-3">
          {gods.map((god) => (
            <li key={god.id}>
              <Link
                href={`/god/${god.id}`}
                className="block rounded-sm border border-ink/15 bg-marble/60 p-6 transition hover:border-gold hover:shadow-md"
              >
                <p
                  className="text-3xl italic"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {god.name}
                </p>
                <p className="mt-1 text-sm text-ink/60">{god.title}</p>
                <p className="mt-4 text-xs uppercase tracking-wider text-laurel">
                  {god.domain}
                </p>
                <dl className="mt-6 grid grid-cols-3 gap-2 border-t border-ink/10 pt-4 text-xs">
                  <div>
                    <dt className="text-ink/50">Reputation</dt>
                    <dd className="font-medium tabular-nums">
                      {god.prophecies_settled === 0
                        ? "—"
                        : `${reputationPct(god.reputationBp)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink/50">Settled</dt>
                    <dd className="font-medium tabular-nums">
                      {god.prophecies_settled}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink/50">Pending</dt>
                    <dd className="font-medium tabular-nums">
                      {god.prophecies_pending}
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 text-[10px] uppercase tracking-wider text-ink/40">
                  Last spoke {fmtSince(god.last_prophecy_at)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-24 border-t border-ink/10 pt-6 text-xs text-ink/50">
        Built on Casper · For the Casper Agentic Buildathon 2026
      </footer>
    </main>
  );
}
