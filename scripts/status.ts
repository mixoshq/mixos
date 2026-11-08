/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `npm run status`: is this checkout's MixOS up, where, and if not, the one
// thing to do about it. The same questions and the same summary that
// `npm run dev:docker` and `npm run dev` print when they start (./local-stack),
// asked again from any terminal at any time — which is when they are usually
// wanted: after a restart, a pull, a laptop waking up, or "wait, is it running?"
//
// It also lists every other MixOS serving on this machine, in Docker or on the
// host, because "which one is on 3000?" is half of every question about ports.
//
// It changes nothing. It exits 0 when every check passed and 1 otherwise, so a
// script or an agent can ask the same question a person does.

import path from "node:path";
import { resolveInstance } from "./instance";
import {
  type Check,
  type Fixes,
  ROOT,
  allOk,
  c,
  checkApp,
  checkReachable,
  configuredDatabase,
  formatSummary,
  isOurs,
  localSignIn,
  localSupabase,
  parseEnvFile,
  portInUse,
  runningMixosApps,
  tilde,
} from "./local-stack";

const START = "Start it with `npm run dev:docker` (all of it in Docker) or `npm run dev` (Next on this computer).";

async function main() {
  const instance = resolveInstance();
  const self = { instance: instance.name, root: ROOT };
  const apps = await runningMixosApps();
  const mine = apps.filter((app) => isOurs(app, self));
  const others = apps.filter((app) => !isOurs(app, self));
  const own = configuredDatabase();
  // A database of the checkout's own is the app's business; the local stack is
  // only this checkout's database when nothing else is named.
  const local = own ? null : localSupabase();
  const envDocker = parseEnvFile(path.join(ROOT, ".env.docker"));

  console.log(c.bold(`\nMixOS status — instance \`${instance.name}\`, ${tilde(ROOT)}`));

  const checks: Check[] = [];
  const app = mine[0];
  if (app) {
    const fixes: Fixes = {
      notRunning: app.docker
        ? `\`docker compose -p ${instance.name} logs app-dev\` says why (\`app\` for the prod profile).`
        : "Its terminal says why.",
      noDatabase: own
        ? `The app can't reach the database named in ${own}. Check DATABASE_URL.`
        : local
          ? "The app can't reach the local database. Restart it with `npm run dev:docker`."
          : "The local database isn't running. `npm run dev:docker -- --db-only` starts it.",
      schemaBehind: own
        ? "Apply the platform migrations with `npm run db:migrate`, then reload."
        : "Apply the new platform migrations with `npm run db:local`, then reload.",
    };
    checks.push(...(await checkApp(app.url, { fixes, signIn: own ? undefined : localSignIn(envDocker) })));
    if (checks[0].state === "ok") checks[0].lines[0] += `   ${c.dim(app.how)}`;
  } else {
    checks.push({ state: "fail", name: "Web server", lines: ["not running"], fix: START });
    checks.push(await databaseWithoutApp(own, local));
    checks.push({ state: "skip", name: "Sign-in", lines: ["not checked: the app isn't running"] });
  }
  if (local?.studioUrl) {
    checks.push(
      await checkReachable(
        "Studio",
        local.studioUrl,
        "browse and edit the database",
        "`npm run dev:docker -- --db-only` starts it.",
      ),
    );
  }

  const notes: string[] = [];
  for (const extra of mine.slice(1)) {
    notes.push(`This checkout is also serving at ${extra.url} (${extra.how}).`);
  }
  if (others.length) {
    notes.push("Other MixOS copies on this machine:");
    for (const other of others) {
      const from = other.checkout ? `, ${tilde(other.checkout)}` : "";
      notes.push(`  ${other.url.padEnd(24)} \`${other.instance}\`, ${other.how}${from}`);
    }
  }

  const ok = allOk(checks);
  process.stdout.write(
    formatSummary({
      headline: !app
        ? "MixOS isn't running for this checkout"
        : ok
          ? `MixOS is up at ${app.url}`
          : `MixOS is running at ${app.url}, but something is wrong — see below`,
      checks,
      notes,
    }),
  );
  process.exit(ok ? 0 : 1);
}

/**
 * The database line when there is no app to ask. The local stack can still be
 * looked at directly; a database of the checkout's own cannot be judged
 * without the app, so it is named and left unchecked.
 */
async function databaseWithoutApp(
  own: string | null,
  local: ReturnType<typeof localSupabase>,
): Promise<Check> {
  if (own) return { state: "skip", name: "Database", lines: [`yours, from ${own}: not checked without the app`] };
  if (!local) {
    return {
      state: "fail",
      name: "Database",
      lines: ["the local database isn't running"],
      fix: "`npm run dev:docker` starts it with the app; `npm run dev:docker -- --db-only` starts it alone.",
    };
  }
  const at = new URL(local.dbUrl);
  return (await portInUse(Number(at.port)))
    ? { state: "ok", name: "Database", lines: [`up, at ${at.hostname}:${at.port}`] }
    : {
        state: "fail",
        name: "Database",
        lines: [`nothing answers at ${at.hostname}:${at.port}`],
        fix: "`npm run docker:down`, then `npm run dev:docker`.",
      };
}

main().catch((err: unknown) => {
  console.error(`\n${c.red("npm run status failed:")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
