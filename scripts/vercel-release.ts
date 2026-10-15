/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The release step in a Vercel build.
//
// vercel.json makes `npm run vercel-build` the build command, and that runs
// `npm run build` and then this script. So this starts only once `next build`
// has succeeded, and a build that doesn't compile leaves the database
// untouched. `npm run build` has also just run the Node check and the registry
// generator, so the release step reads the same registry `next build` compiled.
//
// A production build (VERCEL_ENV=production) runs the release step,
// scripts/release.ts, and fails if it fails, so Vercel keeps serving the
// previous deployment. Every other build skips it: a preview's database is
// often production's own, and a branch nobody has merged must not migrate it.
// Two production builds at once take turns at the migration lock
// (scripts/migration-lock.ts).
//
// The release step runs before Vercel moves traffic to the new deployment, so
// the deployment still serving runs against the migrated database until then,
// and again after an Instant Rollback, which rebuilds nothing. So a migration
// has to work with the deployment before it: add in one release, remove in a
// later one. docs/hosting/providers/vercel-supabase.md has the rest.
//
// The build log is readable by everyone on the project, so nothing here prints
// a connection string: messages name the variable, never its value.

import { spawn } from "node:child_process";
import path from "node:path";
import { connectionUrl, connectionUrlName, databaseNamed } from "../src/lib/db/pg-options";

const ROOT = path.resolve(__dirname, "..");

export interface ReleaseDecision {
  run: boolean;
  /** Why, for the build log. */
  reason: string;
}

/** Whether this build runs the release step. Only a production build does. */
export function releaseDecision(env: NodeJS.ProcessEnv): ReleaseDecision {
  const target = env.VERCEL_ENV;
  if (target === "production") {
    return { run: true, reason: "this is a production build (VERCEL_ENV=production)" };
  }
  if (!target) {
    return {
      run: false,
      reason: "VERCEL_ENV is not set, so this is not a Vercel production build",
    };
  }
  return {
    run: false,
    reason: `this is a ${target} build (VERCEL_ENV=${target}), and only production builds run it`,
  };
}

export interface ReleaseConnection {
  /** The environment to start the release step with. */
  env: NodeJS.ProcessEnv;
  /** The variable that names the database, for the build log. Never its value. */
  source: string;
  /** For the build log, when DATABASE_URL_UNPOOLED is set and not used. */
  warning?: string;
}

/**
 * The environment the release step starts with: this build's own, except that
 * the provider's direct connection string replaces the pooled one when there is
 * one for the same database. Neon's Vercel integration sets both: the pooled
 * DATABASE_URL for the app's functions, and DATABASE_URL_UNPOOLED, which Neon
 * recommends for schema migrations. The release step also works through a
 * transaction pooler, because its lock is transaction-scoped, so this is a
 * preference, not a requirement.
 *
 * Only when both strings sign in as the same role, with the same password, to
 * the same database name, as Neon's two do through different hosts. The
 * release step has to migrate the database the app uses, as the role the app
 * uses (docs/hosting/install.md, "Step 3: Create the database"). A DATABASE_URL_UNPOOLED
 * left over from a database the project has moved off would otherwise take
 * the migrations somewhere else.
 *
 * The app's string comes from connectionUrl, as the app's own does. An app on
 * the discrete PG* fields keeps them: a URL would win over them.
 */
export function releaseConnection(env: NodeJS.ProcessEnv): ReleaseConnection {
  const appUrl = connectionUrl(env);
  const source = connectionUrlName(env) ?? "PGHOST and the other PG* variables";
  const unpooled = env.DATABASE_URL_UNPOOLED;
  if (!unpooled || !appUrl) return { env, source };

  if (!sameRoleAndDatabase(appUrl, unpooled)) {
    return {
      env,
      source,
      warning:
        `DATABASE_URL_UNPOOLED is not used, because this build can't confirm it names the ` +
        `same role and database as ${source}. The release step connects with ${source}, ` +
        `as the app does.`,
    };
  }
  return { env: { ...env, DATABASE_URL: unpooled }, source: "DATABASE_URL_UNPOOLED" };
}

/** Same role, password and database name. Hosts aren't compared. Unparsable means no. */
function sameRoleAndDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    const parts = (u: URL) =>
      [u.username, u.password, u.pathname].map((part) => decodeURIComponent(part)).join("\n");
    return parts(x) === parts(y);
  } catch {
    return false;
  }
}

/** Starts the release step with `env` and resolves to its exit code. */
export type RunRelease = (env: NodeJS.ProcessEnv) => Promise<number>;

/**
 * Everything this build does about the release step. Resolves to the exit code
 * the build ends with: anything but 0 fails it.
 */
export async function vercelRelease(
  env: NodeJS.ProcessEnv,
  runRelease: RunRelease,
  print: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const decision = releaseDecision(env);
  if (!decision.run) {
    print.log(`Release step: skipped, because ${decision.reason}.`);
    return 0;
  }

  if (!databaseNamed(env)) {
    print.error(
      `Release step: failing the build, because ${decision.reason} and DATABASE_URL is not set. ` +
        `Set it for the Production environment in the Vercel project, then redeploy. ` +
        `The previous deployment keeps serving.`,
    );
    return 1;
  }

  const connection = releaseConnection(env);
  print.log(
    `Release step: running, because ${decision.reason}. It connects with ${connection.source}.`,
  );
  if (connection.warning) print.error(`Release step: ${connection.warning}`);

  const code = await runRelease(connection.env);
  if (code !== 0) {
    print.error("Release step failed, so this build fails. The previous deployment keeps serving.");
  }
  return code;
}

/**
 * scripts/release.ts, with exactly `env`. The same step `npm run release` runs,
 * without that script's Node check and registry generator, which
 * `npm run build` has just run.
 */
const spawnRelease: RunRelease = (env) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts", "release.ts")],
      { cwd: ROOT, env, stdio: "inherit" },
    );
    child.on("error", (err) => {
      console.error(`Release step: could not start it: ${err.message}`);
      resolve(1);
    });
    // A signal leaves no exit code; that is a failure too.
    child.on("close", (code) => resolve(code ?? 1));
  });

if (require.main === module) {
  vercelRelease(process.env, spawnRelease).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // The message only: an error object's own fields can carry what it was
      // given, and this is the build log.
      console.error(`Release step failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
