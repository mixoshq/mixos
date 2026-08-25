// Canonical server-side data entry point.
//
// Two clients, deliberately:
//
//   createServiceClient()  — the Supabase JS client. Use this for essentially
//                            everything: it is the documented app-facing API
//                            (`ctx.db.table(...)`) and the platform's own
//                            reads and writes.
//
//   sql                    — the raw postgres.js pool, re-exported from
//                            ./client. Use ONLY where PostgREST genuinely
//                            cannot express the query: aggregate reporting
//                            (src/lib/analytics/queries.ts), the scheduler's
//                            atomic claim (src/lib/apps/scheduler.ts), the
//                            rate limiter's atomic token bucket
//                            (src/lib/rate-limit.ts), and telemetry rollups.
//                            Apps must never reach for it
//                            (see apps/AGENTS.md invariant 18).
//
// Both talk to the same Supabase Postgres database; they differ only in
// transport (PostgREST over HTTPS vs. a pooled TCP connection).
export { createServiceClient } from "./supabase";
export type { SupabaseClient } from "./supabase";
export { sql } from "./client";
