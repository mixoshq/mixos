/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBuiltDeployment } from "../platform/build";
import { DEFAULT_REPOSITORY_URL, RepositoryError, repositoryBaseUrl } from "./client";

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The URL `repositoryBaseUrl()` settles on, and what it logged on the way. */
function resolve(env: { built: boolean; url: string | undefined }) {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    // `VERCEL` is one of the two markers; the other, a standalone `server.js`
    // at the working directory, is absent from a checkout running its tests.
    const base = withEnv(
      { VERCEL: env.built ? "1" : undefined, MIXOS_REPOSITORY_URL: env.url },
      () => {
        assert.equal(isBuiltDeployment(), env.built);
        return repositoryBaseUrl();
      },
    );
    return { base, warnings };
  } finally {
    console.warn = warn;
  }
}

const LOCAL = [
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "http://[::1]:4321",
  "http://host.docker.internal:4321",
];

test("unset or empty is mixos.org, built or not", () => {
  for (const built of [false, true]) {
    for (const url of [undefined, "", "   "]) {
      assert.equal(resolve({ built, url }).base, DEFAULT_REPOSITORY_URL);
    }
  }
});

// The warning is logged once per process, so these two run before anything
// else in this file is ignored.
test("a built deployment honours a catalogue on its own machine, quietly", () => {
  for (const url of LOCAL) {
    const { base, warnings } = resolve({ built: true, url });
    assert.equal(base, url);
    assert.deepEqual(warnings, [], url);
  }
});

test("mixos.org itself is not an override", () => {
  const { base, warnings } = resolve({ built: true, url: "https://mixos.org/" });
  assert.equal(base, DEFAULT_REPOSITORY_URL);
  assert.deepEqual(warnings, []);
});

test("a built deployment ignores a catalogue that is not on its own machine, and logs it", () => {
  const first = resolve({ built: true, url: "https://staging.mixos.example" });
  assert.equal(first.base, DEFAULT_REPOSITORY_URL);
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /built deployment/);

  for (const url of ["https://mirror.example.com/catalogue", "http://mixos.org", "not a url"]) {
    assert.equal(resolve({ built: true, url }).base, DEFAULT_REPOSITORY_URL, url);
  }
});

test("a source checkout honours any https catalogue, and plaintext on this machine", () => {
  assert.equal(
    resolve({ built: false, url: "https://staging.mixos.example/path" }).base,
    "https://staging.mixos.example",
  );
  for (const url of LOCAL) {
    assert.equal(resolve({ built: false, url }).base, url);
  }
});

test("a source checkout refuses plaintext off this machine, and a value that is not a URL", () => {
  for (const url of ["http://staging.mixos.example", "not a url"]) {
    assert.throws(
      () => resolve({ built: false, url }),
      (err: unknown) => err instanceof RepositoryError && err.failure === "config",
      url,
    );
  }
});
