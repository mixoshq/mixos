/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release step in a Vercel build (scripts/vercel-release.ts): which builds
 * run it, which connection string it gets, what its outcome does to the build,
 * and how `npm run vercel-build` orders it after `next build`. The release step
 * is a stand-in throughout; scripts/release.test.ts runs the real one.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseConnection, releaseDecision, vercelRelease } from "./vercel-release";

const REPO = path.resolve(__dirname, "..");

/** ProcessEnv's type requires a NODE_ENV, which nothing here reads. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

// Neon's pair: one role, password and database, through two hosts.
const PASSWORD = "npg_S3cretPw";
const POOLED = `postgresql://neondb_owner:${PASSWORD}@ep-cool-river-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
const DIRECT = `postgresql://neondb_owner:${PASSWORD}@ep-cool-river-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
// Another Neon project: the same default role and database names, its own password.
const OTHER_PASSWORD = "npg_0therPw";
const OTHER = `postgresql://neondb_owner:${OTHER_PASSWORD}@ep-old-lake-654321.eu-west-2.aws.neon.tech/neondb?sslmode=require`;

describe("which builds run the release step", () => {
  test("a production build does", () => {
    assert.equal(releaseDecision(env({ VERCEL_ENV: "production" })).run, true);
  });

  for (const [build, vars] of [
    ["a preview build", { VERCEL_ENV: "preview" }],
    ["a custom environment's build", { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging" }],
    ["a development build", { VERCEL_ENV: "development" }],
    ["a build with VERCEL_ENV unset (a laptop, or CI)", {}],
    ["a build with VERCEL_ENV empty", { VERCEL_ENV: "" }],
  ] as const) {
    test(`${build} does not`, () => {
      assert.equal(releaseDecision(env(vars)).run, false);
    });
  }
});

describe("which connection string the release step gets", () => {
  test("the direct one, when it is for the same role and database", () => {
    const c = releaseConnection(env({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT }));
    assert.equal(c.env.DATABASE_URL, DIRECT);
    assert.equal(c.source, "DATABASE_URL_UNPOOLED");
    assert.equal(c.warning, undefined);
  });

  test("the app's own, when the direct one is for another database, and the log says so", () => {
    const c = releaseConnection(env({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: OTHER }));
    assert.equal(c.env.DATABASE_URL, POOLED);
    assert.equal(c.source, "DATABASE_URL");
    assert.match(c.warning ?? "", /DATABASE_URL_UNPOOLED is not used/);
  });

  test("the app's own, when there is no direct one", () => {
    const c = releaseConnection(env({ DATABASE_URL: POOLED }));
    assert.equal(c.env.DATABASE_URL, POOLED);
    assert.equal(c.source, "DATABASE_URL");
    assert.equal(c.warning, undefined);
  });

  test("POSTGRES_URL counts as the app's own, as it does for the app", () => {
    const c = releaseConnection(env({ POSTGRES_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT }));
    assert.equal(c.env.DATABASE_URL, DIRECT);
  });

  test("an app on the PG* fields keeps them, since a URL would win over them", () => {
    const c = releaseConnection(
      env({
        PGHOST: "db.example.com",
        PGUSER: "mixos",
        PGPASSWORD: PASSWORD,
        PGDATABASE: "mixos",
        DATABASE_URL_UNPOOLED: DIRECT,
      }),
    );
    assert.equal(c.env.DATABASE_URL, undefined);
    assert.match(c.source, /PGHOST/);
  });

  test("an app string that doesn't parse is left for the release step to report", () => {
    const broken = POOLED.replace(PASSWORD, "npg_S3cret#Pw");
    const c = releaseConnection(env({ DATABASE_URL: broken, DATABASE_URL_UNPOOLED: DIRECT }));
    assert.equal(c.env.DATABASE_URL, broken);
  });
});

/** vercelRelease, with a stand-in release step that exits with `code`. */
async function build(vars: Record<string, string>, code = 0) {
  const started: NodeJS.ProcessEnv[] = [];
  const lines: string[] = [];
  const collect = (line: string) => lines.push(line);
  const exit = await vercelRelease(
    env(vars),
    async (releaseEnv) => {
      started.push(releaseEnv);
      return code;
    },
    { log: collect, error: collect },
  );
  return { exit, started, output: lines.join("\n") };
}

const PRODUCTION = { VERCEL_ENV: "production" };

describe("what the release step does to the build", () => {
  test("a preview build skips it, and says why in one line", async () => {
    const run = await build({ VERCEL_ENV: "preview", DATABASE_URL: POOLED });
    assert.equal(run.exit, 0);
    assert.equal(run.started.length, 0);
    assert.equal(run.output.split("\n").length, 1);
    assert.match(run.output, /^Release step: skipped, because this is a preview build/);
  });

  test("a build without VERCEL_ENV skips it, and says why in one line", async () => {
    const run = await build({ DATABASE_URL: POOLED });
    assert.equal(run.exit, 0);
    assert.equal(run.started.length, 0);
    assert.equal(run.output.split("\n").length, 1);
    assert.match(run.output, /^Release step: skipped, because VERCEL_ENV is not set/);
  });

  test("a production build runs it, and passes when it passes", async () => {
    const run = await build({ ...PRODUCTION, DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT });
    assert.equal(run.exit, 0);
    assert.equal(run.started.length, 1);
    assert.equal(run.started[0].DATABASE_URL, DIRECT);
    assert.match(run.output, /^Release step: running, because this is a production build/);
  });

  test("a production build fails when the release step fails", async () => {
    const run = await build({ ...PRODUCTION, DATABASE_URL: POOLED }, 1);
    assert.equal(run.started.length, 1);
    assert.equal(run.exit, 1);
    assert.match(run.output, /The previous deployment keeps serving/);
  });

  test("a production build with no database fails, rather than skip", async () => {
    const run = await build({ ...PRODUCTION });
    assert.equal(run.exit, 1);
    assert.equal(run.started.length, 0);
    assert.match(run.output, /DATABASE_URL is not set/);
    assert.match(run.output, /Production environment/);
  });

  test("the build log names variables, never a connection string or password", async () => {
    for (const vars of [
      { ...PRODUCTION, DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT },
      { ...PRODUCTION, DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: OTHER },
      { ...PRODUCTION, POSTGRES_URL: POOLED },
      { VERCEL_ENV: "preview", DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT },
    ]) {
      for (const code of [0, 1]) {
        const { output } = await build(vars, code);
        for (const secret of [PASSWORD, OTHER_PASSWORD, "neon.tech"]) {
          assert.ok(!output.includes(secret), `the build log showed ${secret}:\n${output}`);
        }
      }
    }
  });
});

describe("npm run vercel-build", () => {
  test("is the build command vercel.json gives Vercel", () => {
    const config = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
    assert.equal(config.buildCommand, "npm run vercel-build");
  });

  /**
   * The `vercel-build` script, run with `sh -c` as npm runs it, against
   * stand-ins for npm and tsx that log each call and exit as told.
   */
  function vercelBuild(npmExit: number, tsxExit: number) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mixos-vercel-build-"));
    try {
      const calls = path.join(bin, "calls.log");
      for (const [name, exit] of [
        ["npm", npmExit],
        ["tsx", tsxExit],
      ] as const) {
        fs.writeFileSync(
          path.join(bin, name),
          `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit ${exit}\n`,
          { mode: 0o755 },
        );
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
      const run = spawnSync("sh", ["-c", pkg.scripts["vercel-build"]], {
        cwd: REPO,
        env: env({ PATH: `${bin}:/usr/bin:/bin` }),
        encoding: "utf8",
      });
      const log = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
      return { status: run.status, calls: log };
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }

  test("a build that doesn't compile never reaches the release step", () => {
    const run = vercelBuild(1, 0);
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls, ["npm run build"]);
  });

  test("a release step that fails fails the build", () => {
    const run = vercelBuild(0, 1);
    assert.notEqual(run.status, 0);
    assert.deepEqual(run.calls, ["npm run build", "tsx scripts/vercel-release.ts"]);
  });

  test("the build passes when both do", () => {
    const run = vercelBuild(0, 0);
    assert.equal(run.status, 0);
    assert.deepEqual(run.calls, ["npm run build", "tsx scripts/vercel-release.ts"]);
  });
});
