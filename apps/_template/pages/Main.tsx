export default function ExampleAppPage() {
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-8 text-center">
      <h1 className="text-5xl font-extrabold tracking-tight">Example App</h1>
      <p className="mt-4 max-w-lg text-lg text-muted-foreground">
        The same thing we do every night, Louis &mdash; try to take over the
        world!
      </p>
      <div className="mt-8 rounded-xl border border-border bg-card px-8 py-6 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          World Domination Progress
        </p>
        <div className="mt-3 h-3 w-64 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[4%] rounded-full bg-mixnavy" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          4% &mdash; but we&apos;re feeling optimistic
        </p>
      </div>
    </div>
  );
}
