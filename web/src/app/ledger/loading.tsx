// Instant skeleton for the ledger feed while the DB query runs.

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-sm bg-ink/[0.07] ${className ?? ""}`}
    />
  );
}

export default function LoadingLedger() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Bone className="h-4 w-24" />
      <header className="mt-8 border-b border-ink/10 pb-8">
        <Bone className="h-3 w-28" />
        <Bone className="mt-3 h-10 w-80 max-w-full" />
        <Bone className="mt-4 h-4 w-96 max-w-full" />
      </header>
      <section className="mt-8 space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Bone key={i} className="h-12 w-full" />
        ))}
      </section>
    </main>
  );
}
