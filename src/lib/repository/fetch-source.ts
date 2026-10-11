/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fetching an extension's code from GitHub.
 *
 * mixos.org hands over a `tarballUrl`. That is a URL chosen by a remote service
 * which this server is then asked to request — i.e. an SSRF primitive, and
 * "it came from mixos.org" is not a control: mixos.org is exactly the party the
 * content hash exists because we do not fully trust.
 *
 * So the URL is not used as given. It has to survive three checks:
 *
 *   1. **Host allowlist.** Only GitHub's own code-download hosts. This is what
 *      stops the URL pointing at `169.254.169.254`, at an internal service, or
 *      at `file:`.
 *   2. **It must be pinned to the commit.** The path has to contain the full
 *      40-character SHA from the manifest. A URL naming a branch or a tag would
 *      resolve to whatever that pointer says today, which is the mutability the
 *      whole release model exists to remove.
 *   3. **Every redirect hop is re-checked.** `api.github.com` legitimately
 *      redirects to `codeload.github.com`, so redirects cannot simply be
 *      refused — but a followed redirect is a second URL chosen by someone
 *      else, and `fetch`'s automatic following would apply none of the above to
 *      it. So they are followed by hand (`./redirects`, which the catalogue
 *      client shares), with checks 1 and 2 run on each.
 *
 * The bytes never reach the filesystem here. They are decompressed and read in
 * memory so the hash can be verified before anything is written — see
 * `content-hash.ts` and `install.ts`.
 */

import { MAX_REDIRECTS, fetchCheckingRedirects } from "./redirects";
import { gunzipBounded, readTar, DEFAULT_TAR_LIMITS, type TarEntry } from "./tar";

/**
 * The only hosts a tarball may come from.
 *
 * `codeload.github.com` is where the archives actually live;
 * `api.github.com` and `github.com` both redirect there and are the forms a
 * publisher's URL is likely to take. Nothing else, and no wildcard — a
 * suffix match on "github.com" would admit `github.com.attacker.net`.
 */
const ALLOWED_TARBALL_HOSTS = new Set([
  "codeload.github.com",
  "api.github.com",
  "github.com",
]);

/** Compressed transfer cap. The decompressed cap is `DEFAULT_TAR_LIMITS`. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 30_000;

export class SourceFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFetchError";
  }
}

/**
 * Check a tarball URL against the rules above. Returns the parsed URL.
 *
 * Exported because `install.ts` states the same requirement in its own step
 * list, and a security check that is only reachable through the function that
 * happens to call it is a check nobody can see.
 */
export function assertAllowedTarballUrl(raw: string, commitSha: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceFetchError(`The repository supplied an unparseable download URL.`);
  }
  if (url.protocol !== "https:") {
    throw new SourceFetchError(
      `Downloads must use https. The repository supplied a ${url.protocol} URL.`,
    );
  }
  if (!ALLOWED_TARBALL_HOSTS.has(url.hostname)) {
    throw new SourceFetchError(
      `Downloads are only accepted from GitHub. The repository supplied a URL on ${url.hostname}.`,
    );
  }
  if (url.username || url.password) {
    throw new SourceFetchError("The download URL carries embedded credentials.");
  }
  if (!url.pathname.toLowerCase().includes(commitSha.toLowerCase())) {
    throw new SourceFetchError(
      `The download URL is not pinned to commit ${commitSha.slice(0, 12)}. ` +
        `A URL naming a branch or tag can be moved after publication.`,
    );
  }
  return url;
}

/** GET with redirects followed by hand, re-validating each hop. */
async function fetchPinned(start: URL, commitSha: string): Promise<Response> {
  const res = await fetchCheckingRedirects(start, {
    init: () => ({
      cache: "no-store",
      headers: { accept: "application/gzip, application/octet-stream, */*" },
      // Per request, so a slow redirect does not eat into the archive's own time.
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }),
    // The full check again, on the URL that would be requested next.
    check: (target) => {
      assertAllowedTarballUrl(target.href, commitSha);
    },
    unreachable: (url, err) =>
      new SourceFetchError(
        `Could not download from ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    tooManyRedirects: () =>
      new SourceFetchError(`The download redirected more than ${MAX_REDIRECTS} times.`),
  });

  if (res.status === 404) {
    throw new SourceFetchError(
      `GitHub has no archive at commit ${commitSha.slice(0, 12)}. ` +
        `The repository may have been made private, renamed, or force-pushed.`,
    );
  }
  if (!res.ok) {
    throw new SourceFetchError(`GitHub answered ${res.status} for the download.`);
  }
  return res;
}

/** Buffer a response body, refusing once it passes `limit`. */
async function downloadBounded(res: Response, limit: number): Promise<Buffer> {
  // Trust Content-Length only to fail EARLY. The streaming count below is what
  // actually enforces the cap, since the header is written by the sender.
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new SourceFetchError(
      `The package is ${declared} bytes, over the ${limit}-byte download limit.`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) throw new SourceFetchError("GitHub returned an empty response body.");

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SourceFetchError(
        `The package exceeded the ${limit}-byte download limit.`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Narrow a tree to the subdirectory the extension actually lives in.
 *
 * Applied before hashing, because the hash is defined over the published tree
 * and for a monorepo that IS the subdirectory — see `content-hash.ts`.
 */
export function rootAt(entries: TarEntry[], subpath?: string): TarEntry[] {
  const clean = (subpath ?? "").replace(/^\/+|\/+$/g, "");
  if (!clean) return entries;
  if (clean.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new SourceFetchError(`The repository supplied an unusable subpath: ${subpath}`);
  }
  const prefix = `${clean}/`;
  const inside = entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
  if (inside.length === 0) {
    throw new SourceFetchError(
      `The package contains no directory "${clean}", which is where the repository says the extension lives.`,
    );
  }
  return inside;
}

/**
 * Download and read one release's file tree. Nothing is written to disk.
 *
 * The returned entries are rooted at the extension, so they are exactly what
 * `verifyContentHash` expects and exactly what gets copied into place after it
 * passes.
 */
export async function fetchExtensionTree(params: {
  tarballUrl: string;
  commitSha: string;
  subpath?: string;
}): Promise<TarEntry[]> {
  const url = assertAllowedTarballUrl(params.tarballUrl, params.commitSha);
  const res = await fetchPinned(url, params.commitSha);
  const gz = await downloadBounded(res, MAX_DOWNLOAD_BYTES);
  const tar = gunzipBounded(gz, DEFAULT_TAR_LIMITS.maxTotalBytes);
  return rootAt(readTar(tar), params.subpath);
}
