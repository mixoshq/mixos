/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The extensions the core repository carries: each kind's template, Wall-E,
 * the example app, and the built-in themes, which the build needs one of.
 * Anything else under apps/, connectors/ or themes/ is someone's own and
 * belongs in their own repository, where they commit and deploy it. Danger
 * fails a pull request to mixoshq/mixos that adds one (dangerfile.ts); anyone's
 * own repository commits its extensions as usual.
 */

export const CORE_EXTENSIONS = {
  apps: ["_template", "wall-e"],
  connectors: ["_template", "_template-oauth"],
  themes: ["_template", "mixos", "mixos-dark"],
} as const satisfies Record<string, readonly string[]>;

type Kind = keyof typeof CORE_EXTENSIONS;

/**
 * The extension folders, as `apps/<name>`, that `paths` add to or change
 * outside the core's own: each once, sorted. A file directly under a kind's
 * folder, such as `apps/AGENTS.md`, isn't an extension. Pass added and
 * modified paths only: deleting a stray extension is welcome.
 */
export function strayExtensions(paths: readonly string[]): string[] {
  const stray = new Set<string>();
  for (const p of paths) {
    const m = /^(apps|connectors|themes)\/([^/]+)\/./.exec(p);
    if (!m) continue;
    const kind = m[1] as Kind;
    const own: readonly string[] = CORE_EXTENSIONS[kind];
    if (!own.includes(m[2])) stray.add(`${kind}/${m[2]}`);
  }
  return [...stray].sort();
}
