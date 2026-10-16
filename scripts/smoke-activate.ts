/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Turn an app on in this checkout's database and grant it to a user, for
// `npm run register -- app/<slug> --smoke`. scripts/register-smoke.ts runs it
// as a child process after Register, so it reads the registry the generator
// has just written, and only after checking the database is on this machine.
//
//   tsx scripts/smoke-activate.ts <slug> --user <email> --actor <cli:user@host> [--typed-slug <slug>]
//
// The checks Activate on Admin > Apps and a grant on Admin > Users make, and
// their audit rows, naming the CLI's actor, with `via: "cli"` and `smoke: true`:
//
//   1. The app is in this checkout's registry, and the user is in its database.
//   2. Every connector the app requires is ready
//      (getMissingTenantConfigConnectors()).
//   3. setAppActive(), which refuses an app that replaces a different extension
//      under its slug unless that slug was typed: `--typed-slug`, which
//      `--confirm-replaces` gives. Audited as `app.activate`, with what it
//      replaced.
//   4. A grant, unless the app is global, which every user has. Its role is
//      null, as a grant from Admin > Users stores it, so the user follows the
//      app's `defaultRole`, now and whenever it changes. A role kept from when
//      the app was global (src/lib/apps/grant-rule.ts) becomes a grant with
//      that role, while the app still declares it. Audited as
//      `user.grant.add`, which is how the row shows who granted it: nobody
//      signed in, so `granted_by` is empty.
//
// An app already active, or a grant already there, is left as it is, with no
// audit row. Prints one JSON line: SmokeActivation in ./register-smoke.ts.

import { appRegistry } from "../src/generated/app-registry";
import { setAppActive } from "../src/lib/apps/access";
import { recordAdminAction, type AdminActor } from "../src/lib/apps/admin-audit";
import { CLI_ACTOR_PREFIX } from "../src/lib/apps/audit-actors";
import { getMissingTenantConfigConnectors, missingConnectorSteps } from "../src/lib/apps/connector-gates";
import { IS_GRANT_SQL } from "../src/lib/apps/grant-rule";
import type { AppManifest } from "../src/lib/apps/types";
import { sql } from "../src/lib/db/client";
import type { IdentityDetails } from "../src/lib/repository/identity";
import type { SmokeActivation } from "./register-smoke";

export interface SmokeActivationInput {
  slug: string;
  email: string;
  /** The slug as typed with --confirm-replaces. */
  typedSlug?: string;
  actor: AdminActor;
}

/** What it reads besides the database. Tests give their own. */
export interface SmokeActivationDeps {
  apps: readonly Pick<AppManifest, "slug" | "global" | "roles">[];
  missingConnectors: typeof getMissingTenantConfigConnectors;
}

/** Activate and grant, as described above. Throws only for what nobody expected. */
export async function activateForSmoke(
  input: SmokeActivationInput,
  deps: SmokeActivationDeps = { apps: appRegistry, missingConnectors: getMissingTenantConfigConnectors },
): Promise<SmokeActivation> {
  const { slug, email, typedSlug, actor } = input;

  const manifest = deps.apps.find((a) => a.slug === slug);
  if (!manifest) {
    return {
      ok: false,
      code: "not-in-build",
      message: `${slug} isn't in this checkout's registry, so it can't be activated.`,
    };
  }
  const [user] = await sql<{ id: string }[]>`select id from public.users where email = ${email}`;
  if (!user) {
    return { ok: false, code: "no-user", message: `${email} isn't a user in this checkout's database.` };
  }
  const missing = await deps.missingConnectors(slug);
  if (missing.length > 0) {
    return { ok: false, code: "connectors", message: `${missingConnectorSteps(missing)} before activating this app.` };
  }

  const [row] = await sql<{ is_active: boolean; identity_changed_at: Date | null }[]>`
    select is_active, identity_changed_at from public.apps where slug = ${slug}
  `;
  let activated = false;
  let replaced: IdentityDetails = null;
  if (row?.is_active !== true) {
    let confirmed: Awaited<ReturnType<typeof setAppActive>>;
    try {
      confirmed = await setAppActive(slug, true, typedSlug);
    } catch (err) {
      // setAppActive() is what refuses an app that replaces another without
      // its slug typed. Its words say so.
      if (row?.identity_changed_at) {
        return { ok: false, code: "replaces", message: err instanceof Error ? err.message : String(err) };
      }
      throw err;
    }
    await recordAdminAction(actor, {
      action: "app.activate",
      targetType: "app",
      targetId: slug,
      details: { via: "cli", smoke: true, ...(confirmed ? { replaced: confirmed.replaced } : {}) },
    });
    activated = true;
    replaced = confirmed?.replaced ?? null;
  }

  let grant: "added" | "existing" | "global";
  if (manifest.global) {
    grant = "global";
  } else {
    // As Admin > Users grants it. Nobody signed in, so nobody is recorded as
    // granting it; the audit row names the CLI. A grant already there is left
    // as it is.
    const declared = manifest.roles.map((r) => r.key);
    const added = await sql`
      insert into public.user_app_grants as g (user_id, app_slug, role, role_only)
      values (${user.id}, ${slug}, null, false)
      on conflict (user_id, app_slug) do update
        set role_only  = false,
            role       = case when g.role = any(${declared}::text[]) then g.role end,
            granted_by = null,
            granted_at = now()
        where not ${sql.unsafe(IS_GRANT_SQL)}
      returning g.app_slug
    `;
    grant = added.length > 0 ? "added" : "existing";
    if (grant === "added") {
      await recordAdminAction(actor, {
        action: "user.grant.add",
        targetType: "user",
        targetId: user.id,
        details: { appSlug: slug, via: "cli", smoke: true },
      });
    }
  }
  return { ok: true, activated, replaced, grant };
}

/** The arguments, or why they aren't any. */
function parseArgs(argv: string[]): SmokeActivationInput | string {
  const [slug, ...rest] = argv;
  const value = (flag: string) => {
    const at = rest.indexOf(flag);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  const email = value("--user");
  const actor = value("--actor");
  const typedSlug = value("--typed-slug");
  if (!slug || slug.startsWith("--") || !email || !actor) {
    return "Usage: tsx scripts/smoke-activate.ts <slug> --user <email> --actor <cli:user@host> [--typed-slug <slug>]";
  }
  // Only ever the CLI's own name: this is how a shell, with no admin signed in, is recorded.
  if (!actor.startsWith(CLI_ACTOR_PREFIX)) return `--actor must be a CLI actor, ${CLI_ACTOR_PREFIX}<user>@<host>.`;
  return { slug, email, actor: { id: null, email: actor }, ...(typedSlug ? { typedSlug } : {}) };
}

if (require.main === module) {
  const input = parseArgs(process.argv.slice(2));
  const answer = (result: SmokeActivation, code: number) =>
    // Exit once the line is written: stdout to a pipe can be asynchronous.
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      process.exitCode = code;
    });
  if (typeof input === "string") {
    answer({ ok: false, code: "usage", message: input }, 2);
  } else {
    activateForSmoke(input)
      .then(
        (result) => answer(result, result.ok ? 0 : 1),
        (err) => {
          console.error(err);
          answer({ ok: false, code: "failed", message: err instanceof Error ? err.message : String(err) }, 1);
        },
      )
      .finally(() => sql.end({ timeout: 5 }).catch(() => {}));
  }
}
