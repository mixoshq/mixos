/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The HTTP client for the mixos.org repository — the only module that knows
 * mixos.org has URLs.
 *
 * Four calls, all through `requestJson`:
 *
 *   GET  /api/v1/search                → a page of SUMMARIES
 *   GET  /api/v1/<kind>/<slug>         → one full listing
 *   GET  /api/v1/<kind>/<slug>/install → an InstallManifest
 *   POST /api/v1/updates               → the update check's answer
 *
 * ── WHY SEARCH AND DETAIL ARE SEPARATE CALLS ────────────────────────────────
 *
 * Because the repository makes them separate shapes. `/search` returns
 * `ExtensionSummary` — no `sourceRepo`, no `releases`, no `description` — which
 * is what keeps a page of 24 small. Everything the browse grid renders comes
 * from a summary; the detail call happens once, when an admin opens the
 * register dialog and those facts start to matter.
 *
 * ── STATE OF THE UPSTREAM ───────────────────────────────────────────────────
 *
 * The endpoints are live, and the catalogue behind them is seeded: every
 * release currently publishes `sha256-PLACEHOLDER-<slug>` in place of a real
 * checksum. Browsing works against it; installing does not and must not, which
 * `isVerifiableHash` is what enforces. `MIXOS_REPOSITORY_URL` still exists so an
 * instance can be pointed at a local checkout of the site (`astro dev`, port
 * 4321) or a fixture, and "the repository is not answering" stays a first-class
 * rendered state rather than an error page.
 *
 * ── WHAT THIS MODULE REFUSES TO DO ──────────────────────────────────────────
 *
 * It does not fetch code, and it does not decide anything. It parses a remote
 * payload into the shapes in `./types` and hands them on. Verification,
 * validation and the filesystem all live in `./install`, downstream of here,
 * because a module that both talks to the network and writes to disk is one
 * where the boundary between them stops being reviewable.
 */

import { isBuiltDeployment } from "../platform/build";
import { MAX_REDIRECTS, fetchCheckingRedirects } from "./redirects";
import {
  ExtensionSchema,
  InstallManifestSchema,
  KIND_SEGMENT,
  PageSchema,
  UpdateCheckResponseSchema,
  UpdateResultSchema,
  type Extension,
  type ExtensionKind,
  type ExtensionPage,
  type InstallManifest,
  type ListQuery,
  type UpdateItem,
  type UpdateResult,
} from "./types";

/**
 * The repository this instance browses.
 *
 * `MIXOS_REPOSITORY_URL` overrides it so the platform can be developed against
 * a staging catalogue, a local copy of the site or a fixture server. A built
 * deployment honours the override only for a catalogue on its own machine — see
 * `repositoryBaseUrl`.
 */
export const DEFAULT_REPOSITORY_URL = "https://mixos.org";

/**
 * Hosts where the traffic never leaves this machine. Two rules turn on them:
 * plaintext http is accepted only here, and a built deployment honours
 * `MIXOS_REPOSITORY_URL` only when it names one of them.
 *
 * ── WHY HTTPS IS OTHERWISE REQUIRED ─────────────────────────────────────────
 *
 * This is where the `contentHash` comes from. A plaintext catalogue over a real
 * network lets anyone on the path choose which hash this instance verifies
 * against — and a hash the attacker picked verifies whatever the attacker sent,
 * which quietly turns the entire install pipeline into a no-op. So the
 * transport carrying the checksum has to be authenticated even though the
 * download it describes is not.
 *
 * ── WHY THESE FOUR ARE EXEMPT ───────────────────────────────────────────────
 *
 * Because on all four the traffic never leaves the machine, so there is no path
 * for anyone to be on. The first three are ordinary loopback. The fourth needs
 * saying out loud:
 *
 * `host.docker.internal` is how a container reaches a port published on the
 * host, and it is the ONLY way the Docker stack — the project's default local
 * path — can reach a fixture server. Inside the container `localhost` is the
 * container itself, so without this entry the documented way to exercise this
 * feature locally does not work under the documented way to run the project.
 *
 * It is safe for a reason specific to it, not by analogy: the name is written
 * into the container's hosts file by Docker itself, from the `extra_hosts:
 * ["host.docker.internal:host-gateway"]` that every service in
 * docker-compose.yml declares. It is not resolved over DNS, so there is no
 * resolver for an attacker to answer, and Docker Desktop proxies it to host
 * loopback. Same trust as `localhost`, reached from one hop away.
 *
 * NOT gated on NODE_ENV. `npm run docker:prod` runs the production-parity
 * profile with NODE_ENV=production, and that is one of the profiles this entry
 * exists to serve — a gate would disable it exactly where it is wanted. It
 * costs nothing in a real deployment either: on Vercel the name does not
 * resolve, so the request simply fails to connect.
 *
 * This mirrors the shape RFC 8252 gives OAuth redirect URIs, which the MCP
 * authorization server already follows (docs/security-architecture.md §17):
 * https everywhere, http on loopback.
 */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  // WHATWG `URL` keeps the brackets on an IPv6 literal, so this is the form
  // `url.hostname` actually produces for http://[::1]:8791.
  "[::1]",
  "host.docker.internal",
]);

/** Warn once per process, not once per request. */
let overrideWarned = false;

export function repositoryBaseUrl(): string {
  // An EMPTY value counts as unset, not as a misconfiguration. `??` alone would
  // let `MIXOS_REPOSITORY_URL=` — which is what a compose passthrough with no
  // value substitutes, and what an untouched `.env` line looks like — fall
  // through to `new URL("")` and fail the page with "not a valid URL" when the
  // author plainly meant "use the default".
  const configured = (process.env.MIXOS_REPOSITORY_URL || "").trim();
  if (!configured) return DEFAULT_REPOSITORY_URL;

  let url: URL | null = null;
  try {
    url = new URL(configured);
  } catch {
    // Reported below, unless a built deployment ignores the value anyway.
  }

  /*
    A BUILT DEPLOYMENT SEARCHES mixos.org, OR A CATALOGUE ON ITS OWN MACHINE.

    The override exists so the platform and the catalogue can be developed
    against each other. That is a development affordance, and on a deployment
    it is a way for the wrong catalogue — someone's laptop, a stale staging
    mirror, a value that leaked into a committed env file — to become the source
    of the checksums every install on that deployment verifies against. The
    checksum is the whole control; whoever chooses the catalogue chooses what
    "verified" means.

    Every built deployment: the Docker image on any host, and Vercel
    (`isBuiltDeployment`). A catalogue on the deployment's own machine is still
    honoured, which is what lets `npm run docker:prod` browse a local copy of the
    site at http://host.docker.internal:4321.

    IGNORED, NOT REFUSED. A deployment that failed to boot because of a stray
    environment variable would be a worse outcome than one that quietly used the
    right catalogue, and there is no case where refusing to start is the safer
    branch: the correct value is known, so it is used and the mistake is logged.

    This is the last of four layers, and the only one that holds against a value
    set in a deployment's own environment — see docs/security-architecture.md
    §31.
  */
  const local = url !== null && LOCAL_HOSTS.has(url.hostname);
  if (isBuiltDeployment() && !local && url?.origin !== DEFAULT_REPOSITORY_URL) {
    if (!overrideWarned) {
      overrideWarned = true;
      console.warn(
        `[repository] Ignoring MIXOS_REPOSITORY_URL (${url ? url.origin : "not a valid URL"}): ` +
          `a built deployment searches ${DEFAULT_REPOSITORY_URL}, or a catalogue on its ` +
          `own machine (${[...LOCAL_HOSTS].join(", ")}). Unset the variable to silence this.`,
      );
    }
    return DEFAULT_REPOSITORY_URL;
  }

  if (!url) {
    throw new RepositoryError(
      `MIXOS_REPOSITORY_URL is not a valid URL: ${configured}`,
      "config",
    );
  }
  if (url.protocol !== "https:" && !local) {
    throw new RepositoryError(
      `MIXOS_REPOSITORY_URL must use https on ${url.hostname}. Plaintext is ` +
        `accepted only where the traffic cannot leave this machine: ` +
        `${[...LOCAL_HOSTS].join(", ")}.`,
      "config",
    );
  }
  return url.origin;
}

/** Where the failure was, so the UI can say something better than "error". */
export type RepositoryFailure =
  /** MIXOS_REPOSITORY_URL itself is wrong. An admin has to fix the deployment. */
  | "config"
  /** No answer: DNS, connection refused, timeout. The common case today. */
  | "unreachable"
  /** Answered, but not with a success status. */
  | "status"
  /** Answered successfully with something that is not the documented shape. */
  | "malformed"
  /** The listing or release genuinely is not there. */
  | "not-found";

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly failure: RepositoryFailure,
    readonly status?: number,
    /**
     * How long the repository asked to be left alone, from a `Retry-After` on
     * an answer that wasn't a success. mixos.org sends one with the 503 its
     * operator's switch answers while the API is off.
     */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

/**
 * Bounded on purpose, and short.
 *
 * These calls run inside a server action while an admin waits on a spinner. A
 * repository that is slow is, from this page's point of view, a repository that
 * is down, and saying so in eight seconds is better than holding the request
 * open until the platform's own function timeout kills it with no message.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Cap on a catalogue response. Search results are metadata — tagline,
 * categories, a few release rows — and 4 MB is already far past a page of them.
 * The cap exists because `res.json()` on an unbounded body is a memory
 * exhaustion primitive handed to whoever controls the other end.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Whether a catalogue request may follow a redirect to `target`: only within
 * the catalogue's own origin, the scheme, host and port it was sent to.
 *
 * A redirect is a URL the catalogue's answer chose, and the catalogue's answers
 * are where the checksums come from. Followed anywhere else, to another host or
 * from https down to http, whoever answers there chooses the hash every install
 * verifies against: the hole the https rule above exists to close. Within the
 * origin, it is the same catalogue over the same transport.
 *
 * The transport rule is restated here rather than inherited from
 * `repositoryBaseUrl`: https, or http on one of the LOCAL_HOSTS. And no
 * credentials in the URL, which `fetch` refuses with an error quoting the URL,
 * credentials and all.
 */
function withinCatalogue(target: URL, catalogue: URL): boolean {
  return (
    target.origin === catalogue.origin &&
    (target.protocol === "https:" || LOCAL_HOSTS.has(target.hostname)) &&
    !target.username &&
    !target.password
  );
}

/** What one request to the catalogue sends, beyond its path. */
export interface CatalogueRequest {
  /** GET unless said otherwise. A POST sends `body` as JSON, and is never redirected. */
  method?: "GET" | "POST";
  /** The query string. */
  params?: URLSearchParams;
  /** A POST's body, sent as JSON. */
  body?: unknown;
}

/**
 * Ask the catalogue one thing and parse its JSON answer.
 *
 * Every call in this module goes through here, and so should any added later,
 * such as the list of MixOS releases (`GET /api/v1/mixos/releases`): this is
 * where the https rule (`repositoryBaseUrl`), the 8-second timeout, the 4 MB
 * cap and the redirect rules live. `path` is absolute, `/api/v1/…`, and must
 * stay on the catalogue's origin: one that resolves elsewhere, such as
 * `//elsewhere.example/…`, is refused before anything is sent.
 *
 * REDIRECTS. A GET follows at most three, each only within the catalogue's own
 * origin (`withinCatalogue`). A POST follows none, and any 3xx answer to one is
 * a failure: a 307 or 308 would send its body again, to wherever the answer
 * chose, and a 301, 302 or 303 would turn it into a GET without its body. The
 * update check's body is this instance's ID and what it runs, which goes to the
 * catalogue or nowhere.
 *
 * Whatever goes wrong is a `RepositoryError`: no answer, or no complete answer
 * in time, is `unreachable`; an answer that isn't a success is `status`, with
 * `retryAfterSeconds` when it carried a `Retry-After`; an answer over the cap,
 * or not JSON, is `malformed`.
 */
export async function requestJson(path: string, request: CatalogueRequest = {}): Promise<unknown> {
  const method = request.method ?? "GET";
  const base = repositoryBaseUrl();
  const url = new URL(path, base);
  if (url.origin !== base) {
    throw new RepositoryError(`${path} is not a path on the repository at ${base}.`, "config");
  }
  if (request.params) url.search = request.params.toString();

  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "POST") headers["content-type"] = "application/json";

  // One timeout for the whole exchange: every redirect, and the body read below.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchCheckingRedirects(url, {
    init: () => ({
      method,
      headers,
      body: method === "POST" ? JSON.stringify(request.body ?? null) : undefined,
      // Catalogue answers are advisory and change; nothing downstream trusts a
      // cached copy, since what is actually trusted is the content hash.
      cache: "no-store",
      signal,
    }),
    // Neither the target nor any part of it goes in the message: it is the
    // other end's choice, and can be long or made to mislead.
    check: (target, status) => {
      if (method !== "GET") {
        throw new RepositoryError(
          `The repository at ${url.origin} answered ${method} ${path} with a redirect (${status}). ` +
            `A ${method} to the catalogue is never redirected.`,
          "status",
          status,
        );
      }
      if (!withinCatalogue(target, url)) {
        throw new RepositoryError(
          `The repository at ${url.origin} redirected ${path} elsewhere. ` +
            `Catalogue requests follow a redirect only within ${url.origin}.`,
          "status",
          status,
        );
      }
    },
    unreachable: (hop, err) =>
      new RepositoryError(
        `Could not reach ${hop.origin}: ${err instanceof Error ? err.message : String(err)}`,
        "unreachable",
      ),
    tooManyRedirects: (status) =>
      new RepositoryError(
        `The repository at ${url.origin} redirected ${path} more than ${MAX_REDIRECTS} times.`,
        "status",
        status,
      ),
  });

  if (res.status === 404) {
    throw new RepositoryError(`Not found in the repository: ${path}`, "not-found", 404);
  }
  if (!res.ok) {
    throw new RepositoryError(
      `The repository answered ${res.status} for ${path}.`,
      "status",
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  // Read as text with a length check rather than calling res.json() directly:
  // the point is to stop before parsing something enormous, and json() has
  // already buffered the whole body by the time it could be measured.
  const body = await readBounded(res, MAX_RESPONSE_BYTES, path);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RepositoryError(
      `The repository returned something that is not JSON for ${path}.`,
      "malformed",
    );
  }
}

/**
 * `Retry-After`, as seconds from now: a number of seconds, or an HTTP date.
 * Undefined when absent or unreadable, and never negative. How far to trust it
 * is the caller's decision; the update check waits at most a day.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  // Every HTTP date starts with the day's name. `Date.parse` alone would also
  // read "-5" or "1.5" as dates.
  if (!/^[A-Za-z]{3}/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Reads a response body, aborting once it exceeds `limit` bytes. A body that
 * stops arriving, or doesn't finish within the request's timeout, is
 * `unreachable`: the answer never came.
 */
async function readBounded(res: Response, limit: number, path: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw new RepositoryError(
        `The repository stopped answering ${path} before it finished: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        "unreachable",
      );
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RepositoryError(
        `The repository response exceeded ${limit} bytes.`,
        "malformed",
      );
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Search the catalogue.
 *
 * `kind` is always sent by the callers here: each browse page is scoped to one
 * kind, matching the admin page it hangs off. A cross-kind search would be a
 * different page with a different button on it.
 */
export async function searchRepository(query: ListQuery): Promise<ExtensionPage> {
  const params = new URLSearchParams();
  if (query.kind) params.set("kind", query.kind);
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.author) params.set("author", query.author);
  if (query.sort) params.set("sort", query.sort);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.featured !== undefined) params.set("featured", String(query.featured));

  const raw = await requestJson("/api/v1/search", { params });
  const parsed = PageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepositoryError(
      `The repository's search response did not match the expected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      "malformed",
    );
  }
  // A listing of a kind other than the one asked for would install into the
  // wrong directory downstream. Cheap to drop here; expensive to notice later.
  const items = query.kind
    ? parsed.data.items.filter((e) => e.kind === query.kind)
    : parsed.data.items;
  return { ...parsed.data, items };
}

/**
 * One full listing.
 *
 * Everything the search endpoint leaves out: the GitHub repository, the release
 * list, the description, the screenshots. Fetched on demand rather than folded
 * into search, because folding it in is the thing the summary shape exists to
 * avoid.
 */
export async function fetchExtension(
  kind: ExtensionKind,
  slug: string,
): Promise<Extension> {
  const raw = await requestJson(`/api/v1/${KIND_SEGMENT[kind]}/${encodeURIComponent(slug)}`);
  const parsed = ExtensionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepositoryError(
      `The repository's listing for ${slug} did not match the expected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      "malformed",
    );
  }
  if (parsed.data.kind !== kind || parsed.data.slug !== slug) {
    throw new RepositoryError(
      `The repository returned ${parsed.data.kind}/${parsed.data.slug} when asked for ${kind}/${slug}.`,
      "malformed",
    );
  }
  return parsed.data;
}

/**
 * Ask how to install one listing.
 *
 * `version` selects a specific release; omitting it takes whatever the
 * repository considers current. The answer is a set of claims — a commit, a
 * URL, a hash — none of which are acted on here.
 */
export async function fetchInstallManifest(
  kind: ExtensionKind,
  slug: string,
  version?: string,
): Promise<InstallManifest> {
  const params = new URLSearchParams();
  if (version) params.set("version", version);

  const raw = await requestJson(
    `/api/v1/${KIND_SEGMENT[kind]}/${encodeURIComponent(slug)}/install`,
    { params },
  );
  const parsed = InstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepositoryError(
      `The repository's install manifest did not match the expected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      "malformed",
    );
  }
  // The manifest decides a directory name and a download. Neither may be for
  // something other than what was asked for, whatever the server says.
  if (parsed.data.kind !== kind || parsed.data.slug !== slug) {
    throw new RepositoryError(
      `The repository returned an install manifest for ${parsed.data.kind}/${parsed.data.slug} ` +
        `when asked for ${kind}/${slug}.`,
      "malformed",
    );
  }
  return parsed.data;
}

/** mixos.org's answer to an update check, with the entries that parsed. */
export interface UpdateCheckAnswer {
  /** When mixos.org answered, as it says. Display only. */
  checkedAt: string | null;
  items: UpdateResult[];
}

/**
 * The update check: ask the catalogue about the extensions this instance
 * installed from it (`POST /api/v1/updates`, run by ./update-check.ts).
 *
 * The body is built here, field by field: the instance ID, and each item's
 * kind, slug and version. Nothing else, whatever else the caller's objects
 * hold: no MixOS version, no URL, nothing about users or data.
 *
 * The answer is read leniently. An entry that doesn't parse is dropped, as
 * mixos.org drops a malformed item from the request, and which entries came
 * back is for the caller to check: `keepAnswersFor()` in ./updates.ts keeps an
 * answer only for an item that was sent, at the version sent.
 */
export async function checkUpdates(
  instanceId: string,
  items: readonly UpdateItem[],
): Promise<UpdateCheckAnswer> {
  const raw = await requestJson("/api/v1/updates", {
    method: "POST",
    body: {
      instanceId,
      items: items.map(({ kind, slug, version }) => ({ kind, slug, version })),
    },
  });
  const parsed = UpdateCheckResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepositoryError(
      `The repository's update check answer did not match the expected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      "malformed",
    );
  }
  const answered: UpdateResult[] = [];
  for (const entry of parsed.data.items) {
    const result = UpdateResultSchema.safeParse(entry);
    if (result.success) answered.push(result.data);
  }
  return { checkedAt: parsed.data.checkedAt ?? null, items: answered };
}
