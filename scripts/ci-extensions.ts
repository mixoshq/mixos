/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two steps of the pull-request check (.github/workflows/extensions.yml).
 *
 *   git diff --name-only --no-renames -z HEAD^1 HEAD | npx tsx scripts/ci-extensions.ts apps
 *
 *     Which apps to smoke-test: each app folder the pull request changes, or
 *     every app when it changes the check itself (CHECK_FILES), so the check
 *     tests itself on its own pull request. Prints `slugs=<slug> <slug>` for
 *     $GITHUB_OUTPUT, and why on stderr. A removed folder is left out; a
 *     folder name that can't be an app's fails the step.
 *
 *   npx tsx scripts/ci-extensions.ts activate --user <email> <slug>...
 *
 *     Activate the apps and grant them to the user, by SQL, on the job's
 *     database (DATABASE_URL). Fails for an app the build left out, which has
 *     no row: the registry generator refused it, and the release step's output
 *     says why.
 *
 * CI only. Activating by SQL skips Activate's own checks (a connector to
 * configure first, a typed slug for an app that replaces another) and its
 * audit row, which is right for a database made for one job and wrong for any
 * other. So `activate` refuses a database that isn't on this machine. In a
 * checkout, use `npm run register -- app/<slug> --smoke`, or Admin > Apps.
 * Each grant is audited, as the CLI, as every grant path records who granted
 * it (src/lib/apps/grant-rule.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import { APP_SLUG_PATTERN } from "../src/lib/apps/app-identifiers";
import { cliActorName } from "../src/lib/apps/audit-actors";
import { IS_GRANT_SQL } from "../src/lib/apps/grant-rule";
import { describeDatabase } from "../src/lib/db/locality";
import { createPgClient } from "../src/lib/db/pg-options";

/**
 * The check's own files. A pull request that changes one tests every app. The
 * workflow's `paths` list them too, and a unit test keeps the two the same.
 */
export const CHECK_FILES: readonly string[] = [
  ".github/workflows/extensions.yml",
  "scripts/smoke-test-app.ts",
  "scripts/app-smoke.ts",
  "scripts/check-install-records.ts",
  "scripts/ci-extensions.ts",
];

export interface AppsToTest {
  slugs: string[];
  /** What a reader of the log should know: why these, and what was left out. */
  notes: string[];
  /** What fails the step. */
  problems: string[];
}

/** Whether `apps/<name>` is a folder the registry generator reads, as opposed to a template or a set-aside copy. */
function isAppFolder(name: string): boolean {
  return !name.startsWith("_") && !name.startsWith(".");
}

/** The apps to smoke-test for a pull request that changes `changed`, in the checkout at `root`. */
export function appsToTest(changed: readonly string[], root: string): AppsToTest {
  const notes: string[] = [];
  const problems: string[] = [];
  const named = new Set<string>();

  const own = changed.filter((f) => CHECK_FILES.includes(f));
  if (own.length > 0) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, "apps"), { withFileTypes: true });
    } catch {
      // No apps/ at all: nothing to test.
    }
    for (const entry of entries) if (entry.isDirectory() && isAppFolder(entry.name)) named.add(entry.name);
    notes.push(`This pull request changes the check itself (${own.join(", ")}), so every app is tested.`);
  } else {
    for (const file of changed) {
      const parts = file.split("/");
      // apps/<folder>/<file>: a top-level file such as apps/AGENTS.md is no app's.
      if (parts[0] !== "apps" || parts.length < 3 || !isAppFolder(parts[1])) continue;
      named.add(parts[1]);
    }
  }

  const slugs: string[] = [];
  for (const name of [...named].sort()) {
    const folder = `apps/${name}/`;
    if (!APP_SLUG_PATTERN.test(name)) {
      problems.push(
        `${JSON.stringify(folder)} can't be an app: a folder name is the app's slug, in lowercase letters and ` +
          "digits joined by single hyphens or underscores.",
      );
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.lstatSync(path.join(root, "apps", name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      notes.push(`${folder} is removed by this pull request, so there is nothing to test.`);
      continue;
    }
    slugs.push(name);
  }
  notes.push(
    slugs.length > 0 ? `Apps to smoke-test: ${slugs.join(", ")}.` : "No app to smoke-test.",
  );
  return { slugs, notes, problems };
}

/** The paths `git diff --name-only` printed: NUL-separated with `-z`, else one per line. */
export function readPaths(text: string): string[] {
  return text
    .split(text.includes("\0") ? "\0" : /\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Activate each app and grant it to the user with `email`, by SQL. Returns what
 * went wrong; an empty list is success.
 */
export async function activateAndGrant(sql: Sql, slugs: readonly string[], email: string): Promise<string[]> {
  const problems: string[] = [];
  const valid = slugs.filter((slug) => {
    if (APP_SLUG_PATTERN.test(slug)) return true;
    problems.push(`${JSON.stringify(slug)} isn't an app slug.`);
    return false;
  });
  if (valid.length === 0) return problems;

  const [user] = await sql<{ id: string }[]>`select id from public.users where email = ${email}`;
  if (!user) return [...problems, `No user ${email} to grant the apps to. Did the release step create the first admin?`];

  const activated = await sql<{ slug: string }[]>`
    update public.apps set is_active = true where slug = any(${valid as string[]}) returning slug
  `;
  const found = new Set(activated.map((r) => r.slug));
  for (const slug of valid) {
    if (!found.has(slug)) {
      problems.push(
        `apps/${slug}/ is in this pull request, but not in the build: the registry generator left it out. ` +
          "The release step's output says why.",
      );
    }
  }
  if (found.size > 0) {
    // A grant for each app that isn't global; every user has a global one. A
    // role kept from when an app was global becomes a grant
    // (src/lib/apps/grant-rule.ts), and a grant already there stays.
    const granted = await sql<{ app_slug: string }[]>`
      insert into public.user_app_grants as g (user_id, app_slug, role_only)
      select ${user.id}, a.slug, false from public.apps a
       where a.slug = any(${[...found]}::text[]) and a.global is not true
      on conflict (user_id, app_slug) do update
        set role_only = false, granted_at = now()
        where not ${sql.unsafe(IS_GRANT_SQL)}
      returning g.app_slug
    `;
    if (granted.length > 0) {
      let osUser = "unknown";
      try {
        osUser = os.userInfo().username;
      } catch {
        // No passwd entry for the job's user: the name says so.
      }
      await sql`
        insert into public.admin_audit_log (actor_id, actor_email, action, target_type, target_id, details)
        select null, ${cliActorName(osUser, os.hostname())}, 'user.grant.add', 'user', ${user.id},
               jsonb_build_object('appSlug', s, 'via', 'ci')
          from unnest(${granted.map((g) => g.app_slug)}::text[]) as s
      `;
    }
    const global = await sql<{ slug: string }[]>`
      select slug from public.apps where slug = any(${[...found]}::text[]) and global
    `;
    const list = (slugs: string[]) => slugs.sort().join(", ");
    console.log(
      `Activated ${list([...found])}` +
        (granted.length > 0 ? `, and granted ${list(granted.map((g) => g.app_slug))} to ${email}` : "") +
        (global.length > 0 ? `; ${list(global.map((g) => g.slug))} ${global.length === 1 ? "is" : "are"} global, so everyone has ${global.length === 1 ? "it" : "them"}` : "") +
        ".",
    );
  }
  return problems;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "apps") {
    const result = appsToTest(readPaths(fs.readFileSync(0, "utf8")), path.resolve(__dirname, ".."));
    for (const note of result.notes) console.error(note);
    for (const problem of result.problems) console.error(problem);
    console.log(`slugs=${result.slugs.join(" ")}`);
    return result.problems.length > 0 ? 1 : 0;
  }

  if (command === "activate") {
    const at = rest.indexOf("--user");
    const email = at >= 0 ? rest[at + 1] : undefined;
    const slugs = rest.filter((_, i) => i !== at && i !== at + 1);
    if (!email || slugs.length === 0) {
      console.error("Usage: npx tsx scripts/ci-extensions.ts activate --user <email> <slug>...");
      return 2;
    }
    const sql = createPgClient({ max: 1, onnotice: () => {} });
    try {
      const database = describeDatabase(sql.options);
      if (!database.local) {
        console.error(
          `The database is on ${database.hosts.join(", ") || "a host this can't name"}, not this machine. ` +
            "This activates apps without Activate's checks or an audit row, so it only runs on the CI " +
            "job's own database.",
        );
        return 1;
      }
      const problems = await activateAndGrant(sql, slugs, email);
      for (const problem of problems) console.error(problem);
      return problems.length > 0 ? 1 : 0;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  console.error("Usage: npx tsx scripts/ci-extensions.ts apps | activate --user <email> <slug>...");
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
