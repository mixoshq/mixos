/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTALL_FLAG,
  installDisabledMessage,
  installEnabled,
  installFlagProblems,
  parseInstallFlag,
} from "./policy";
import type { ExtensionKind } from "./types";

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

test("unset and empty mean on — the default is unchanged behaviour", () => {
  assert.deepEqual(parseInstallFlag("INSTALL_APPS", undefined), { enabled: true, problem: null });
  assert.deepEqual(parseInstallFlag("INSTALL_APPS", ""), { enabled: true, problem: null });
  assert.deepEqual(parseInstallFlag("INSTALL_APPS", "  "), { enabled: true, problem: null });
});

test("the usual spellings of true and false, in any case", () => {
  for (const on of ["true", "TRUE", "True", "1", "yes", "on", " true "]) {
    assert.equal(parseInstallFlag("INSTALL_APPS", on).enabled, true, on);
  }
  for (const off of ["false", "FALSE", "False", "0", "no", "off", " false "]) {
    assert.deepEqual(parseInstallFlag("INSTALL_APPS", off), { enabled: false, problem: null }, off);
  }
});

test("anything else is off, and says why", () => {
  for (const typo of ["flase", "disabled", "2", "nope"]) {
    const flag = parseInstallFlag("INSTALL_THEMES", typo);
    assert.equal(flag.enabled, false, typo);
    assert.match(flag.problem ?? "", /^INSTALL_THEMES=/);
  }
});

test("each kind reads its own variable", () => {
  withEnv({ INSTALL_APPS: "false", INSTALL_CONNECTORS: undefined, INSTALL_THEMES: "true" }, () => {
    assert.equal(installEnabled("app"), false);
    assert.equal(installEnabled("connector"), true);
    assert.equal(installEnabled("theme"), true);
  });
});

test("a kind that is not one of the three is refused, not read as unset", () => {
  // Server action arguments are not type-checked at runtime.
  assert.equal(installEnabled("plugin" as ExtensionKind), false);
  assert.equal(installEnabled("constructor" as ExtensionKind), false);
  assert.deepEqual(Object.keys(INSTALL_FLAG).sort(), ["app", "connector", "theme"]);
});

test("the refusal message is safe to build from an unknown kind", () => {
  assert.match(installDisabledMessage("constructor" as ExtensionKind), /not a kind of extension/);
  assert.match(installDisabledMessage("app"), /INSTALL_APPS/);
});

test("unrecognised values are reported for the release step", () => {
  withEnv({ INSTALL_APPS: "flase", INSTALL_CONNECTORS: "false", INSTALL_THEMES: undefined }, () => {
    const problems = installFlagProblems();
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^INSTALL_APPS=/);
  });
});

test("the install pipeline refuses a disabled kind before it locks or downloads anything", async () => {
  // Imported here so the module's top-level filesystem probe runs under test,
  // not at file load for every other test above.
  const { installExtension, InstallError } = await import("./install");
  const previous = process.env.INSTALL_CONNECTORS;
  process.env.INSTALL_CONNECTORS = "false";
  try {
    await assert.rejects(
      installExtension("connector", "anything"),
      (err: unknown) => err instanceof InstallError && err.code === "disabled",
    );
  } finally {
    if (previous === undefined) delete process.env.INSTALL_CONNECTORS;
    else process.env.INSTALL_CONNECTORS = previous;
  }
});
