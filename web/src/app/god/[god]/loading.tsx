// Instant skeleton while the god page does its DB + chain reads. Without
// this, force-dynamic navigation gives no feedback for seconds and clicks
// feel dead.

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-sm bg-ink/[0.07] ${className ?? ""}`}
    />
  );
}

export default function LoadingGod() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Bone className="h-4 w-24" />
      <header className="mt-8 border-b border-ink/10 pb-10">
        <div className="flex items-start justify-between gap-6">
          <div className="w-full">
            <Bone className="h-3 w-40" />
            <Bone className="mt-3 h-14 w-64" />
          </div>
          <Bone className="size-16 shrink-0 rounded-full" />
        </div>
        <Bone className="mt-5 h-4 w-72" />
        <Bone className="mt-3 h-4 w-96 max-w-full" />
        <div className="mt-8 grid grid-cols-2 gap-6 border-t border-ink/10 pt-6 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i}>
              <Bone className="h-3 w-16" />
              <Bone className="mt-2 h-5 w-12" />
            </div>
          ))}
        </div>
      </header>
      <section className="mt-10 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Bone key={i} className="h-28 w-full" />
        ))}
      </section>
    </main>
  );
}
