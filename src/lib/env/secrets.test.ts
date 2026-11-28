/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The server's secrets, out of `process.env`: the scrub takes every one, the
 * platform still reads its own, the host's are gone for good, and nothing in
 * src/ reads one from `process.env` where the scrub has emptied it.
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import {
  HOST_SECRETS,
  envWithSecrets,
  mixosSecretNames,
  readSecret,
  resetSecretsForTest,
  scrubSecrets,
} from "./secrets";
import { connectionUrl } from "@/lib/db/pg-options";
import { platformKey } from "./keys";

const REPO = path.resolve(__dirname, "../../..");
const KEY = "a".repeat(64);

/** Set these for one test, and put everything back after. */
let saved: Record<string, string | undefined> = {};
function set(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved = {};
  resetSecretsForTest();
});

test("the scrub takes every secret out of process.env; the platform still reads its own", () => {
  set({
    CONNECTOR_ENCRYPTION_KEY: KEY,
    AUTH_SECRET: "auth",
    CRON_SECRET: "cron",
    DATABASE_URL: "postgres://u:pw@db.example.com/mixos",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    INITIAL_ADMIN_PASSWORD: "first",
  });
  const taken = scrubSecrets();
  for (const name of [
    "CONNECTOR_ENCRYPTION_KEY",
    "AUTH_SECRET",
    "CRON_SECRET",
    "DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "INITIAL_ADMIN_PASSWORD",
  ]) {
    assert.ok(taken.includes(name), name);
    assert.equal(process.env[name], undefined, `${name} is still in process.env`);
  }
  assert.ok(!JSON.stringify(process.env).includes("pw@db.example.com"));

  assert.equal(readSecret("AUTH_SECRET"), "auth");
  assert.equal(readSecret("CRON_SECRET"), "cron");
  assert.equal(platformKey("connectorEncryption").toString("hex"), KEY);
  assert.equal(connectionUrl(), "postgres://u:pw@db.example.com/mixos");
  assert.equal(envWithSecrets().DATABASE_URL, "postgres://u:pw@db.example.com/mixos");
});

test("the host's secrets are gone for good, and only a listed name can be read", () => {
  set({ SUPABASE_SERVICE_ROLE_KEY: "service-role" });
  scrubSecrets();
  assert.equal(envWithSecrets().SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.throws(() => readSecret("SUPABASE_SERVICE_ROLE_KEY"), /isn't one of the secrets/);
  assert.throws(() => readSecret("PATH"), /isn't one of the secrets/);
});

test("what it keeps is out of sight on the global object, and frozen", () => {
  set({ AUTH_SECRET: "auth" });
  scrubSecrets();
  assert.ok(!Object.keys(globalThis).some((k) => k.toLowerCase().includes("secret")));
  assert.ok(!JSON.stringify(Object.getOwnPropertyNames(globalThis)).includes("secret"));
  const store = (globalThis as Record<symbol, unknown>)[Symbol.for("mixos.secrets")] as Record<string, string>;
  assert.ok(Object.isFrozen(store));
});

test("a second scrub, a development server re-running register(), keeps what the first took", () => {
  set({ CRON_SECRET: "cron" });
  scrubSecrets();
  scrubSecrets();
  assert.equal(readSecret("CRON_SECRET"), "cron");
});

test("before the scrub, and in scripts and tests, it reads process.env", () => {
  set({ CRON_SECRET: "from-env" });
  assert.equal(readSecret("CRON_SECRET"), "from-env");
});

test("the lint fence names exactly the secrets the scrub keeps", async () => {
  const { SECRET_NAMES } = (await import(path.join(REPO, "eslint.config.mjs"))) as { SECRET_NAMES: string[] };
  assert.deepEqual([...SECRET_NAMES].sort(), [...mixosSecretNames()].sort());
  for (const name of HOST_SECRETS) assert.ok(!mixosSecretNames().includes(name), name);
});

test("the lint fence refuses a secret read from process.env in src/", async () => {
  const eslint = new ESLint({ cwd: REPO });
  const code = [
    "export const a = process.env.AUTH_SECRET;",
    'export const b = process.env["DATABASE_URL"];',
    "export const c = process.env.NEXTAUTH_URL;",
  ].join("\n");
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, "src/lib/fixture.ts") });
  const lines = result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax" && m.message.startsWith("The server takes its secrets"))
    .map((m) => m.line);
  assert.deepEqual(lines, [1, 2]);
});

test("nothing in src/ reads a secret from process.env, but secrets.ts", () => {
  const names = mixosSecretNames().join("|");
  const read = new RegExp(`process\\.env(?:\\.(?:${names})\\b|\\[\\s*["'\`](?:${names})["'\`]\\s*\\])`);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        const rel = path.relative(REPO, full);
        if (rel === path.join("src", "lib", "env", "secrets.ts")) continue;
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (read.test(line)) found.push(`${rel}:${i + 1}`);
          });
      }
    }
  };
  walk(path.join(REPO, "src"));
  assert.deepEqual(found, []);
});
