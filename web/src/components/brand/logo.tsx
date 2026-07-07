// The Pantheon mark: a temple front reduced to the Greek letter Π —
// pediment above, twin columns below, with the oracle's spark (gold) set in
// the tympanum. Stroke-based and currentColor so it sits on marble or ink.

export function Mark({
  className,
  spark = "#c9a45e",
}: {
  className?: string;
  spark?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* pediment */}
      <path
        d="M16 4 4.5 11.5h23L16 4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* oracle's spark in the tympanum */}
      <circle cx="16" cy="9" r="1.6" fill={spark} />
      {/* architrave */}
      <path d="M5 15h22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* columns — the Π */}
      <path d="M9.5 15v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M22.5 15v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* stylobate */}
      <path d="M6.5 28h19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={`uppercase tracking-[0.32em] ${className ?? ""}`}
      style={{ fontFamily: "var(--font-brand)" }}
    >
      Pantheon
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <Mark className="size-6" />
      <Wordmark className="brand-shimmer text-sm font-semibold" />
    </span>
  );
}
