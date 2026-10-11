/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where an extension already in this build came from, as Browse says it on a
 * listing of the same name. From `registryInstalls`, which the registry
 * generator writes from each folder's install record
 * (src/generated/registry-installs.ts, ./install-record.ts):
 *
 *   - from the catalogue Browse asks: "Installed from mixos.org · 1.2.0",
 *     with "modified locally" when its files no longer match its record;
 *   - from another catalogue: "Installed from <host>; not checked here";
 *   - with no record: "A local extension uses this name".
 *
 * An extension is matched by its kind and slug. The catalogue is matched by
 * origin, the way a record names it: two catalogues are one when their
 * origins are equal.
 *
 * Pure, with no imports a browser can't load: the server works it out for the
 * page, and the page for an install it has just made.
 */

import type { RegistryInstall } from "./install-record";
import type { ExtensionKind } from "./types";

export type Provenance =
  /** Installed from the catalogue this instance browses. */
  | { from: "catalogue"; host: string; version: string; modified: boolean }
  /** Installed from another catalogue, which this instance doesn't ask. */
  | { from: "elsewhere"; host: string }
  /** In the build with no install record: written here, or installed before records existed. */
  | { from: "local" };

/** An origin's host, as people say it: `mixos.org`, `localhost:4321`. */
export function sourceHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Where the extension of `kind` named `slug` in this build came from, given
 * the build's installs from a Registry and the origin of the catalogue being
 * browsed.
 */
export function provenanceOf(
  kind: ExtensionKind,
  slug: string,
  installs: readonly RegistryInstall[],
  origin: string,
): Provenance {
  const install = installs.find((i) => i.kind === kind && i.slug === slug);
  if (!install) return { from: "local" };
  if (install.source !== origin) return { from: "elsewhere", host: sourceHost(install.source) };
  return { from: "catalogue", host: sourceHost(install.source), version: install.version, modified: install.modified };
}

/** The line Browse shows in place of an install button. */
export function provenanceLine(p: Provenance): string {
  switch (p.from) {
    case "catalogue":
      return `Installed from ${p.host} · ${p.version}${p.modified ? " · modified locally" : ""}`;
    case "elsewhere":
      return `Installed from ${p.host}; not checked here`;
    case "local":
      return "A local extension uses this name";
  }
}

/** What the line means, for a tooltip. */
export function provenanceDetail(p: Provenance): string {
  switch (p.from) {
    case "catalogue":
      return p.modified
        ? "Its files have changed since it was installed, so they no longer match its install record."
        : "Its files match its install record.";
    case "elsewhere":
      return "It was installed from another catalogue than the one this instance browses.";
    case "local":
      return "This build has an extension of this name with no install record, so it wasn't installed from a Registry, or was installed before installs kept one.";
  }
}
