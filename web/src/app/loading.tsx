// Instant skeleton for the home scoreboard while DB + chain reads run.

function Bone({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-sm bg-ink/[0.07] ${className ?? ""}`}
    />
  );
}

export default function LoadingHome() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="border-b border-ink/10 pb-12">
        <Bone className="h-3 w-64" />
        <Bone className="mt-4 h-12 w-96 max-w-full" />
        <Bone className="mt-5 h-4 w-full max-w-2xl" />
        <Bone className="mt-2 h-4 w-80 max-w-full" />
      </header>
      <section className="mt-12">
        <Bone className="h-3 w-40" />
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Bone key={i} className="h-64 w-full" />
          ))}
        </div>
      </section>
    </main>
  );
}
