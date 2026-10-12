/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { KIND_LABEL, type ExtensionKind } from "./types";

/**
 * Whether this instance installs extensions of a kind from the catalogue:
 * INSTALL_APPS, INSTALL_CONNECTORS and INSTALL_THEMES.
 *
 * ON BY DEFAULT. Unset behaves exactly as MixOS always has. An operator turns a
 * kind off to fix an instance's set of that kind, typically because what runs is
 * chosen in code review and shipped in the build, not by whoever holds an admin
 * account.
 *
 * OFF REMOVES THE PATH, NOT JUST THE LINK. With a kind off:
 *
 *   - its Browse button is gone from the admin page;
 *   - its browse page is a 404 (components/admin/browse/browse-page.tsx);
 *   - the catalogue's server actions refuse it (repository/actions.ts) — they
 *     are directly invocable, so hiding the page alone would not be enough;
 *   - the install pipeline refuses it (repository/install.ts), so a future
 *     caller cannot forget the check either.
 *
 * What it does NOT do: remove or deactivate anything already installed, or stop
 * someone with write access to the repository adding code to apps/ and
 * deploying it. It closes the in-product path, the one an admin account can
 * reach. Activating, configuring and applying installed extensions are
 * unaffected.
 *
 * Read per request, so changing one needs a restart and not a rebuild.
 *
 * PARSING FAILS CLOSED. Unset or empty is on. `true`, `1`, `yes`, `on` are on;
 * `false`, `0`, `no`, `off` are off, in any case. Anything else is OFF, with a
 * warning: whoever set the variable set it to restrict something, and a typo
 * such as `INSTALL_APPS=flase` must not leave installs quietly open.
 */

export const INSTALL_FLAG: Record<ExtensionKind, string> = {
  app: "INSTALL_APPS",
  connector: "INSTALL_CONNECTORS",
  theme: "INSTALL_THEMES",
};

const ON = new Set(["true", "1", "yes", "on"]);
const OFF = new Set(["false", "0", "no", "off"]);

export interface InstallFlag {
  enabled: boolean;
  /** Set when the value was not recognised, and was read as off. */
  problem: string | null;
}

/**
 * Interpret one flag's raw value. Pure, for testing and for release.ts.
 * `off` says what reading it as false turns off, for the problem's message.
 */
export function parseInstallFlag(
  name: string,
  raw: string | undefined,
  off = "installing is off",
): InstallFlag {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || ON.has(value)) return { enabled: true, problem: null };
  if (OFF.has(value)) return { enabled: false, problem: null };
  return {
    enabled: false,
    problem:
      `${name}=${JSON.stringify(raw)} is not true or false, so it is treated as false ` +
      `and ${off}. Use true or false.`,
  };
}

/** Warned once per process, not once per render. */
const warned = new Set<string>();

/** Whether `kind` may be browsed and installed from the catalogue on this instance. */
export function installEnabled(kind: ExtensionKind): boolean {
  // `kind` arrives from a server action's arguments, which the types do not
  // check at runtime. Anything that is not one of the three is refused rather
  // than looked up as a flag that does not exist and read as unset.
  if (!Object.hasOwn(INSTALL_FLAG, kind)) return false;
  const name = INSTALL_FLAG[kind];
  const { enabled, problem } = parseInstallFlag(name, process.env[name]);
  if (problem && !warned.has(name)) {
    warned.add(name);
    console.warn(`[install-policy] ${problem}`);
  }
  return enabled;
}

/**
 * Whether this instance asks the catalogue about the extensions it installed
 * from it: MIXOS_UPDATE_CHECK (./update-check.ts).
 *
 * ON BY DEFAULT, because the check is how a release its publisher withdrew,
 * for a security problem say, reaches the instances running it, and a safety
 * notice behind an opt-in reaches almost nobody. Off, nothing is sent and no
 * instance ID is created.
 *
 * The install flags' parser, so a typo fails the same way: anything but true
 * or false is off, and the release step reports it. Read per tick, so changing
 * it needs a restart and not a rebuild.
 */
export const UPDATE_CHECK_FLAG = "MIXOS_UPDATE_CHECK";

function updateCheckFlag(): InstallFlag {
  return parseInstallFlag(UPDATE_CHECK_FLAG, process.env[UPDATE_CHECK_FLAG], "update checks are off");
}

export function updateCheckEnabled(): boolean {
  const { enabled, problem } = updateCheckFlag();
  if (problem && !warned.has(UPDATE_CHECK_FLAG)) {
    warned.add(UPDATE_CHECK_FLAG);
    console.warn(`[install-policy] ${problem}`);
  }
  return enabled;
}

/**
 * Every switch whose value was not recognised, the install flags and
 * MIXOS_UPDATE_CHECK, for a configuration report.
 */
export function flagProblems(): string[] {
  return [
    ...(Object.keys(INSTALL_FLAG) as ExtensionKind[]).map(
      (kind) => parseInstallFlag(INSTALL_FLAG[kind], process.env[INSTALL_FLAG[kind]]).problem,
    ),
    updateCheckFlag().problem,
  ].filter((p): p is string => p !== null);
}

/** What an admin, or a log, is told when a kind is off. */
export function installDisabledMessage(kind: ExtensionKind): string {
  // Not a lookup on the label maps for an unknown kind: `"constructor"` is a
  // key every object has, and this message is built from untrusted input.
  if (!Object.hasOwn(INSTALL_FLAG, kind)) {
    return `${JSON.stringify(kind)} is not a kind of extension this instance installs.`;
  }
  return (
    `Installing ${KIND_LABEL[kind].many.toLowerCase()} is turned off on this instance ` +
    `(${INSTALL_FLAG[kind]}). The ${KIND_LABEL[kind].many.toLowerCase()} it runs are ` +
    `the ones it was deployed with.`
  );
}
