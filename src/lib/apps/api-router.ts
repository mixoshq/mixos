/**
 * Map URL segments to an on-disk `apps/<slug>/api/<routePath>/route.ts`.
 *
 * Used by the gateway (`src/lib/apps/dispatch.ts`) for both mounts. It
 * understands Next-style dynamic segments: `/report/123` resolves to
 * `report/[id]` when `apps/<slug>/api/report/[id]/route.ts` exists.
 *
 * Resolution order at each level, matching Next:
 *   1. a literal directory of that name,
 *   2. a single-segment dynamic directory `[id]`,
 *   3. a catch-all `[...rest]`, which consumes every remaining segment.
 *
 * Three properties this deliberately holds, each of which was previously wrong:
 *
 * - **Directories only.** The listing used to include files, so a URL segment
 *   that happened to equal a filename (`helpers.ts`) matched as a "literal",
 *   the next read threw, and resolution returned null instead of trying the
 *   dynamic sibling.
 * - **Deterministic.** The dynamic candidate used to be the first entry in raw
 *   `readdir` order, which is not sorted and not stable across filesystems. Two
 *   dynamic siblings resolved by accident. They are sorted now, and a
 *   single-segment match is preferred over a catch-all rather than whichever
 *   sorted first.
 * - **Catch-alls actually work.** Each URL segment used to consume exactly one
 *   directory level, so `[...path]` could never match more than one segment —
 *   while the registry hoisted it and the gateway's param extraction promised
 *   to join the rest. The feature was documented, generated, and unreachable.
 *
 * Returns `null` when nothing matches or no `route.ts` sits at the leaf. Path
 * traversal is safe by construction: every emitted component came from a
 * directory listing, never from the URL.
 */

import { promises as fs } from "fs";
import path from "path";

const APPS_DIR = path.join(process.cwd(), "apps");

function isDynamic(name: string): boolean {
  return name.startsWith("[") && name.endsWith("]");
}

function isCatchAll(name: string): boolean {
  return name.startsWith("[...") || name.startsWith("[[...");
}

async function readDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function resolveRoutePath(
  appSlug: string,
  segments: string[],
): Promise<string | null> {
  let cursor = path.join(APPS_DIR, appSlug, "api");
  const parts: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const dirs = await readDirectories(cursor);

    if (dirs.includes(segment)) {
      parts.push(segment);
      cursor = path.join(cursor, segment);
      continue;
    }

    const dynamics = dirs.filter(isDynamic).sort();
    const single = dynamics.find((d) => !isCatchAll(d));
    if (single) {
      parts.push(single);
      cursor = path.join(cursor, single);
      continue;
    }

    const catchAll = dynamics.find(isCatchAll);
    if (!catchAll) return null;

    // A catch-all swallows this segment and every one after it. The gateway's
    // `extractPathParams` joins the same remainder back into one value.
    parts.push(catchAll);
    cursor = path.join(cursor, catchAll);
    break;
  }

  try {
    await fs.access(path.join(cursor, "route.ts"));
  } catch {
    return null;
  }
  return parts.join("/");
}
