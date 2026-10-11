/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The verdict of an install's check, as `generate-project-registry.ts --check`
 * writes it and `checkExtension()` in ./install.ts reads it.
 *
 * One JSON object, alone in a file the installing process named:
 *
 *     {"verdict":"accepted"|"rejected","problems":[…],"deferred":[…]}
 *
 * A file, and not a line of output, because the check's output repeats what
 * the extension says about itself: file names, manifest strings, the text of a
 * schema error. Anything printed there could be made to look like a verdict.
 * The file is the only place a verdict can come from, and stdout and stderr are
 * shown to the admin and never parsed.
 *
 * Shared by both ends so that what one writes is exactly what the other
 * accepts.
 */

import { z } from "zod";

/** A verdict file larger than this is not one the check wrote. */
export const CHECK_VERDICT_MAX_BYTES = 1024 * 1024;

/** The most problems a verdict lists; the check folds the rest into one line. */
export const CHECK_MAX_PROBLEMS = 100;
/** The most deferred items a verdict lists. */
export const CHECK_MAX_DEFERRED = 200;
/** The longest a single problem or deferred item may be. */
export const CHECK_MAX_ITEM_CHARS = 4_000;

const CheckVerdictSchema = z
  .strictObject({
    verdict: z.enum(["accepted", "rejected"]),
    /** Each names its file. Empty exactly when accepted. */
    problems: z.array(z.string().min(1)).max(CHECK_MAX_PROBLEMS + 1),
    /**
     * What the check could not read without running the extension's code, so
     * the generator checks it when the extension is registered.
     */
    deferred: z.array(z.string().min(1)).max(CHECK_MAX_DEFERRED + 1),
  })
  .refine((v) => (v.verdict === "accepted") === (v.problems.length === 0), {
    message: "an accepted verdict lists no problems, and a rejected one lists at least one",
  });

export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;

/**
 * The verdict in a file's text, or null when the text is not exactly one
 * well-formed verdict: not JSON, two values, a key too many or too few, or an
 * accepted verdict that lists problems.
 */
export function parseCheckVerdict(text: string): CheckVerdict | null {
  let value: unknown;
  try {
    // JSON.parse takes the whole text as one value, so a second object, or
    // anything after the first, is a syntax error here rather than ignored.
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = CheckVerdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A verdict's file contents: one line of JSON. */
export function serializeCheckVerdict(verdict: CheckVerdict): string {
  return `${JSON.stringify(verdict)}\n`;
}

/**
 * A verdict for `problems` and `deferred`, each list cut to its limit, so a
 * package with thousands of findings still produces a verdict the install path
 * will read.
 */
export function buildCheckVerdict(problems: readonly string[], deferred: readonly string[]): CheckVerdict {
  const clip = (s: string) => (s.length > CHECK_MAX_ITEM_CHARS ? `${s.slice(0, CHECK_MAX_ITEM_CHARS - 1)}…` : s);
  const cap = (items: readonly string[], max: number, noun: string) =>
    items.length > max
      ? [...items.slice(0, max).map(clip), `…and ${items.length - max} more ${noun}.`]
      : items.map(clip);
  return {
    verdict: problems.length > 0 ? "rejected" : "accepted",
    problems: cap(problems, CHECK_MAX_PROBLEMS, "problems"),
    deferred: cap(deferred, CHECK_MAX_DEFERRED, "items"),
  };
}
