/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTALL_FLAG,
  RELEASE_CHANNEL_SETTING,
  UPDATE_CHECK_FLAG,
  flagProblems,
  installDisabledMessage,
  installEnabled,
  parseInstallFlag,
  parseReleaseChannel,
  releaseChannel,
  releaseChannelProblem,
  updateCheckEnabled,
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
  withEnv(
    { INSTALL_APPS: "flase", INSTALL_CONNECTORS: "false", INSTALL_THEMES: undefined, MIXOS_UPDATE_CHECK: undefined },
    () => {
      const problems = flagProblems();
      assert.equal(problems.length, 1);
      assert.match(problems[0], /^INSTALL_APPS=/);
    },
  );
});

test("MIXOS_UPDATE_CHECK: unset is on", () => {
  assert.equal(UPDATE_CHECK_FLAG, "MIXOS_UPDATE_CHECK");
  for (const value of [undefined, "", "  "]) {
    withEnv({ MIXOS_UPDATE_CHECK: value }, () => assert.equal(updateCheckEnabled(), true, String(value)));
  }
  for (const value of ["true", "1", "yes", "ON"]) {
    withEnv({ MIXOS_UPDATE_CHECK: value }, () => assert.equal(updateCheckEnabled(), true, value));
  }
});

test("MIXOS_UPDATE_CHECK: false, 0 and off are off, and nothing is reported", () => {
  for (const value of ["false", "0", "off", "no", "FALSE"]) {
    withEnv({ MIXOS_UPDATE_CHECK: value, INSTALL_APPS: undefined, INSTALL_CONNECTORS: undefined, INSTALL_THEMES: undefined }, () => {
      assert.equal(updateCheckEnabled(), false, value);
      assert.deepEqual(flagProblems(), [], value);
    });
  }
});

test("MIXOS_UPDATE_CHECK: a typo is off, and reported as update checks being off", () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    withEnv({ MIXOS_UPDATE_CHECK: "flase", INSTALL_APPS: undefined, INSTALL_CONNECTORS: undefined, INSTALL_THEMES: undefined }, () => {
      assert.equal(updateCheckEnabled(), false);
      const problems = flagProblems();
      assert.equal(problems.length, 1);
      assert.match(problems[0], /^MIXOS_UPDATE_CHECK="flase" is not true or false/);
      assert.match(problems[0], /update checks are off/);
      assert.doesNotMatch(problems[0], /installing/);
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MIXOS_UPDATE_CHECK=/);
});

test("MIXOS_RELEASE_CHANNEL: stable by default, prerelease when asked, in any case", () => {
  assert.equal(RELEASE_CHANNEL_SETTING, "MIXOS_RELEASE_CHANNEL");
  for (const value of [undefined, "", "  ", "stable", " Stable "]) {
    assert.deepEqual(parseReleaseChannel(value), { channel: "stable", problem: null }, String(value));
  }
  for (const value of ["prerelease", "PRERELEASE", " prerelease\n"]) {
    assert.deepEqual(parseReleaseChannel(value), { channel: "prerelease", problem: null }, value);
  }
  withEnv({ MIXOS_RELEASE_CHANNEL: "prerelease" }, () => {
    assert.equal(releaseChannel(), "prerelease");
    assert.equal(releaseChannelProblem(), null);
  });
  withEnv({ MIXOS_RELEASE_CHANNEL: undefined }, () => assert.equal(releaseChannel(), "stable"));
});

test("MIXOS_RELEASE_CHANNEL: anything else is stable, warned once, and reported for the release step", () => {
  // Not a channel, however close: a typo shows fewer releases, never more.
  for (const value of ["beta", "prereleases", "pre-release", "rc", "true", "all"]) {
    const { channel, problem } = parseReleaseChannel(value);
    assert.equal(channel, "stable", value);
    assert.equal(
      problem,
      `MIXOS_RELEASE_CHANNEL=${JSON.stringify(value)} is not stable or prerelease, so it is treated as stable and prereleases aren't shown. Use stable or prerelease.`,
    );
  }
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    withEnv({ MIXOS_RELEASE_CHANNEL: "beta", INSTALL_APPS: undefined, INSTALL_CONNECTORS: undefined, INSTALL_THEMES: undefined, MIXOS_UPDATE_CHECK: undefined }, () => {
      assert.equal(releaseChannel(), "stable");
      assert.equal(releaseChannel(), "stable");
      assert.match(releaseChannelProblem() ?? "", /^MIXOS_RELEASE_CHANNEL="beta" is not stable or prerelease/);
      // A channel isn't a switch, so the switches' list leaves it out.
      assert.deepEqual(flagProblems(), []);
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[release-check\] MIXOS_RELEASE_CHANNEL="beta"/);
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
