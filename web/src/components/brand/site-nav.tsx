import Link from "next/link";
import { Logo } from "./logo";

const LINKS = [
  { href: "/god/demeter", label: "Demeter" },
  { href: "/god/hermes", label: "Hermes" },
  { href: "/god/apollo", label: "Apollo" },
  { href: "/ledger", label: "Ledger" },
  { href: "/petition", label: "Petition" },
  { href: "/verify", label: "Verify" },
] as const;

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink/10 bg-marble/80 backdrop-blur-md">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-ink transition hover:text-gold">
          <Logo />
          <span className="sr-only">Pantheon home</span>
        </Link>
        <div className="flex items-center gap-5 text-[11px] uppercase tracking-[0.2em] text-ink/60">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="transition hover:text-gold"
            >
              {l.label}
            </Link>
          ))}
          <a
            href="https://github.com/dmetagame/pantheon"
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-ink/20 px-2.5 py-1 transition hover:border-gold hover:text-gold"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}
