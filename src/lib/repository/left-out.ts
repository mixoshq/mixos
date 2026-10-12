/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The files install leaves out of a package: `.gitignore` and `.gitattributes`,
 * at any depth and in any case.
 *
 * Git reads both from the tree it adds, so either would change what the
 * operator's repository records when the extension is committed, or how a
 * review shows it: `.gitattributes` can hide a diff (`-diff`) or mark files as
 * generated, and `.gitignore` can keep a file the extension runs out of the
 * commit. Most extension repositories have a `.gitignore` at the top, so
 * install leaves them out rather than refuse the package (leaveOut() in
 * ./install.ts), and mixos.org's publish check skips them. A `.git` is still
 * refused.
 *
 * Install counts what it left out by name. The install result and
 * `npm run register` say it in one line, the pending sidecar keeps it until
 * Register, and the install's audit row records it.
 *
 * No imports a browser can't load: the install dialog uses leftOutLine().
 */

import { z } from "zod";

/** The names install leaves out, as foldPath() in ./install.ts spells them. */
export const LEFT_OUT_NAMES = [".gitignore", ".gitattributes"] as const;
export type LeftOutName = (typeof LEFT_OUT_NAMES)[number];

/**
 * Whether a file of this name is one install leaves out. Compared folded, as
 * foldPath() in ./install.ts folds it, so `.GitIgnore` is one too.
 */
export function isLeftOutName(name: string): boolean {
  const folded = name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  return (LEFT_OUT_NAMES as readonly string[]).includes(folded);
}

/** How many files of each name install left out: `{ ".gitignore": 2 }`, or `{}`. */
export const LeftOutSchema = z.partialRecord(z.enum(LEFT_OUT_NAMES), z.number().int().positive());
export type LeftOut = z.infer<typeof LeftOutSchema>;

/**
 * What install left out, in one line for a person, or null when it left out
 * nothing: "Left out .gitignore (2 files): MixOS doesn't install git control
 * files."
 */
export function leftOutLine(leftOut: LeftOut): string | null {
  const named = LEFT_OUT_NAMES.flatMap((name) => {
    const files = leftOut[name] ?? 0;
    return files > 0 ? [`${name} (${files} ${files === 1 ? "file" : "files"})`] : [];
  });
  if (named.length === 0) return null;
  return `Left out ${named.join(" and ")}: MixOS doesn't install git control files.`;
}
