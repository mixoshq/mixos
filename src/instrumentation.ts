// THIS FILE MUST LIVE AT src/instrumentation.ts, beside src/app — not at the
// repo root. Next derives the directory it scans for the hook as
// `<appDir>/..`, which for src/app is src/, and it reads that one directory
// non-recursively. A copy at the repo root is therefore never seen. The trap
// is that `next dev` resolves the root file anyway: a misplaced hook works for
// the whole of local development and is then simply absent from
// `output: "standalone"` (no instrumentation.js is copied into
// .next/standalone) and from the Vercel build, which uses the same detection.
// Nothing warns at build time and nothing throws at runtime — register() just
// never runs, so the listeners it was supposed to install are silently missing
// in production only.
//
// Next.js runs `register()` once per server instance, before any request is
// handled. It is the only place in the app lifecycle where an app can register
// server-side hook listeners: a hook fired from the server (a scheduled job, an
// API route) runs before any of that app's client code has ever been imported,
// so without a registration here nothing would be listening.
//
// No app registers server-side listeners today, so this is deliberately empty
// rather than deleted — the file is the documented extension point, and without
// it the next app to need a server-fired listener has to rediscover why its
// hook never fires.
//
// This is NOT the scheduler's home. The 5-minute tick lives behind
// GET /api/cron (src/app/api/cron/route.ts): a serverless instance is frozen
// between requests and cannot hold a timer. Vercel Cron drives it in production
// (vercel.json) and the compose `cron` sidecar drives it locally in Docker. An
// in-process timer here would fire a second, uncoordinated tick beside them —
// runDueJobs() survives that (the Postgres claim is atomic), but the duplicate
// wastes a connection every 5 minutes and makes job timing impossible to reason
// about. Do not "restore" startScheduler(); it no longer exists, on purpose.
export async function register() {
  // When an app needs this, gate the import on the Node runtime — `register()`
  // also runs in the Edge runtime, where a listener module that touches the DB
  // or a connector cannot load:
  //
  //   if (process.env.NEXT_RUNTIME === "nodejs") {
  //     await import("@apps/<slug>/server-hooks");
  //   }
}
