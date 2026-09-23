/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — the platform's primary data path.
 *
 * The service role bypasses Row-Level Security. That is deliberate and is the
 * model the whole schema is built on: RLS is enabled with zero policies purely
 * to keep PostgREST's `anon` surface closed (see supabase/migrations/
 * 0001_initial.sql), while every real authorization decision is made in
 * application code — src/lib/apps/access.ts, src/lib/connectors/config.ts,
 * src/lib/mcp/.
 *
 * Consequences worth stating plainly:
 *   - This client must NEVER be constructed in code that reaches the browser.
 *     It lives behind server components, server actions, and route handlers.
 *   - SUPABASE_SERVICE_ROLE_KEY is a full-database credential. It is not
 *     NEXT_PUBLIC_-prefixed, so Next.js will not inline it into a client
 *     bundle; keep it that way.
 */

const globalForSupabase = globalThis as unknown as {
  __supabase?: SupabaseClient;
};

function build(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      !url && "SUPABASE_URL",
      !key && "SUPABASE_SERVICE_ROLE_KEY",
    ].filter(Boolean);
    throw new Error(
      `Missing required Supabase env vars: ${missing.join(", ")}. ` +
        `Set them in .env.local (locally) or in the Vercel project's ` +
        `environment variables. Both are shown in the Supabase dashboard ` +
        `under Project Settings -> API.`,
    );
  }

  return createClient(url, key, {
    auth: {
      // No user session is ever attached to this client — auth is NextAuth's
      // job (src/lib/auth/). Turning these off stops the SDK from touching
      // storage or spawning a refresh timer that would leak across requests.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Cached on globalThis for the same reason the Postgres pool is: Next.js
 * re-evaluates modules on hot reload, and a fresh client per evaluation leaks
 * fetch agents. Construction is lazy so `next build` — which loads server
 * modules to collect page data — never needs the env vars present.
 */
export function createServiceClient(): SupabaseClient {
  if (!globalForSupabase.__supabase) {
    globalForSupabase.__supabase = build();
  }
  return globalForSupabase.__supabase;
}

export type { SupabaseClient };
