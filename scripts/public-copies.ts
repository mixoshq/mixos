/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The copies the registry generator makes in public/, and pruning the ones it
 * no longer makes.
 *
 * A full run copies what each extension publishes for pages read without a
 * session, each extension into a folder of its own, at one of five places:
 *
 *   public/themes/<slug>/               a theme's assets/
 *   public/screenshots/themes/<slug>/   a theme's declared screenshots
 *   public/screenshots/apps/<slug>/     an app's declared screenshots
 *   public/branding/apps/<slug>/        an app's declared brand marks
 *   public/connector-assets/<name>/     a connector's assets/
 *
 * Each place is exempt from the sign-in redirect in src/proxy.ts, for the
 * reason each copy exists: a theme's fonts and logo and a brand mark render on
 * the sign-in page, before anyone has a session; a listing's screenshots are
 * read by someone deciding whether to install; and next/image's optimizer
 * fetches a connector's icon server-side with no cookies. Connector assets are
 * not under public/connectors/ because `/connectors/*` is already a signed-in
 * page route (/connectors/guide), so assets served from there would redirect to
 * /login. All five are git-ignored: the committed files are the extensions'.
 *
 * Each copy is recorded in src/generated/public-copies.json before it is made.
 * At the end of a full run, a folder an earlier run recorded and this run
 * didn't copy is deleted: its extension was removed or renamed, the build left
 * it out, or it no longer publishes those files. A folder an earlier run
 * recorded and this run copies into again is emptied first, so a file an
 * updated extension no longer publishes goes with the release that had it.
 * Only a folder in that record is ever deleted or emptied, only at one of the
 * five places, and only when it is a real folder rather than a link. Nothing
 * else in public/ is touched.
 *
 * A run that stops partway deletes no folder it didn't copy into, and its
 * record keeps every copy it made, so the next full run prunes what this one
 * would have, and copies again what it emptied.
 *
 * Node built-ins only.
 */

import fs from "fs";
import path from "path";

/** Where the generator copies to, under public/. */
export const COPY_PLACES = [
  "themes",
  "screenshots/themes",
  "screenshots/apps",
  "branding/apps",
  "connector-assets",
] as const;
export type CopyPlace = (typeof COPY_PLACES)[number];

/** One folder name: no separator, not `.` or `..`, and not a dot folder. */
function isFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !name.startsWith(".") && !/[/\\\0]/.test(name);
}

/** `themes/aurora` as its place and its folder name, or null when it isn't one of the five places' folders. */
function parseEntry(entry: unknown): { place: CopyPlace; name: string } | null {
  if (typeof entry !== "string") return null;
  for (const place of COPY_PLACES) {
    if (!entry.startsWith(`${place}/`)) continue;
    const name = entry.slice(place.length + 1);
    return isFolderName(name) ? { place, name } : null;
  }
  return null;
}

/** The entries a record holds that name a folder at one of the five places. Anything else is ignored. */
function readRecord(file: string): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return new Set();
  }
  const copies = (value as { copies?: unknown } | null)?.copies;
  if (!Array.isArray(copies)) return new Set();
  return new Set(copies.filter((entry): entry is string => parseEntry(entry) !== null));
}

/**
 * This run's copies into public/, against the record an earlier run left.
 * `publicDir` is the checkout's public/, and `recordFile` where the record is
 * kept: src/generated/public-copies.json.
 */
export class PublicCopies {
  private readonly earlier: Set<string>;
  private readonly made = new Set<string>();

  constructor(
    private readonly publicDir: string,
    private readonly recordFile: string,
  ) {
    this.earlier = readRecord(recordFile);
  }

  /**
   * The folder to copy `name`'s files into at `place`, recorded before
   * anything is copied, so a run that stops partway still knows it made it.
   */
  folder(place: CopyPlace, name: string): string {
    if (!isFolderName(name)) throw new Error(`"${name}" can't name a folder in public/${place}/.`);
    const entry = `${place}/${name}`;
    if (!this.made.has(entry)) {
      this.made.add(entry);
      // An earlier run's copy is emptied, so what this run copies is all there is.
      if (this.earlier.has(entry)) this.remove(place, name);
      else this.write(new Set([...this.earlier, ...this.made]));
    }
    return path.join(this.publicDir, place, name);
  }

  /**
   * Delete each folder an earlier run recorded and this run didn't copy, then
   * record this run's copies alone. Returns what it deleted, as `place/name`.
   * Called once, at the end of a full run that finished.
   */
  prune(): string[] {
    const deleted: string[] = [];
    for (const entry of [...this.earlier].sort()) {
      if (this.made.has(entry)) continue;
      const parsed = parseEntry(entry);
      if (parsed && this.remove(parsed.place, parsed.name)) deleted.push(entry);
    }
    this.write(this.made);
    return deleted;
  }

  /**
   * Delete the folder `name` at `place`, when it is a real folder there.
   * Returns whether it deleted one. The generator only ever makes folders
   * here: anything else, a link included, was put there by someone else, and
   * is left alone.
   */
  private remove(place: CopyPlace, name: string): boolean {
    const parent = path.join(this.publicDir, place);
    const dir = path.join(parent, name);
    if (path.dirname(dir) !== parent) return false;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      return false; // Already gone.
    }
    if (!stat.isDirectory()) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  private write(entries: ReadonlySet<string>): void {
    fs.mkdirSync(path.dirname(this.recordFile), { recursive: true });
    const tmp = `${this.recordFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ copies: [...entries].sort() }, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, this.recordFile);
  }
}
