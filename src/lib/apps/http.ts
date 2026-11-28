/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import { AppError } from "@/lib/apps/errors";

/**
 * Outbound HTTP for app code, bounded by a declared host allowlist.
 *
 * `docs/security-architecture.md` §13 said the platform had no SSRF defence and
 * called it "a gap to close *before* the next feature that fetches a URL" — while
 * app routes could already `fetch()` anything. This closes it, and the ESLint ban
 * on raw `fetch` in `apps/**` is what makes it the only door.
 *
 * BOTH HALVES ARE REQUIRED, and the second is the one people skip:
 *
 *   1. **Check the hostname against the app's declared `egress`.** The manifest
 *      schema already rejects schemes, ports, paths and IP literals, so what
 *      arrives here is a bare hostname.
 *   2. **Resolve it and re-check every returned address, then connect to that
 *      address.** Validating the string alone is defeated by DNS rebinding: an
 *      attacker registers a name that resolves public at validation time and
 *      private at fetch time. Resolving once and pinning the answer is what
 *      makes the allowlist mean anything — so the request never resolves the
 *      name again. It goes out over node:http(s) with a `lookup` that answers
 *      with the addresses already checked (`requestPinned`), because `fetch`
 *      offers no way to hand a request its address.
 *
 * Redirects are followed manually for the same reason — a 302 to
 * `169.254.169.254` would otherwise walk straight past both checks.
 */

/** Private, loopback, link-local and unique-local ranges. */
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) return isPrivateV6(address);

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local, and where every cloud metadata endpoint lives.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT and benchmarking ranges are not somewhere an app should
  // be reaching either.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address, or null if it does not parse.
 * Read through the URL parser first, which lower-cases it, writes an embedded
 * dotted quad as hex, and refuses a zone id — so `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` arrive here as the same thing.
 */
function ipv6Groups(address: string): number[] | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const halves = canonical.split("::");
  const groups = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
  const head = groups(halves[0]);
  const tail = halves.length > 1 ? groups(halves[1]) : [];
  const all =
    halves.length > 1
      ? [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
      : head;
  return all.length === 8 && all.every((g) => g >= 0 && g <= 0xffff) ? all : null;
}

function isPrivateV6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true; // unreadable, or scoped to an interface: not public
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = (hi: number, lo: number) =>
    isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, 4);

  // `::`, `::1`, and the deprecated IPv4-compatible `::a.b.c.d`.
  if (zero(0, 6)) return true;
  // An IPv4 address carried inside v6 is judged as that IPv4 address: mapped
  // (::ffff:0:0/96), translated (::ffff:0:0:0/96), NAT64 (64:ff9b::/96) and
  // 6to4 (2002::/16).
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  // Local-use NAT64 (64:ff9b:1::/48) and Teredo (2001::/32) tunnel to an
  // address this check cannot see.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // Unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10,
  // multicast ff00::/8, discard-only 100::/64.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g[0] === 0x100 && zero(1, 4)) return true;
  return false;
}

/** `*.example.com` matches one level of subdomain, never the apex. */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const target = host.toLowerCase();
  return allowlist.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (!target.endsWith(suffix)) return false;
      const label = target.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".");
    }
    return target === rule;
  });
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

async function resolveAll(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

/**
 * Every address `hostname` resolves to, each one checked: a single non-public
 * answer refuses the request. An IP literal is checked as it stands. What this
 * returns is what the request may connect to, and nothing else.
 */
export async function checkedAddresses(
  hostname: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = resolveAll,
): Promise<ResolvedAddress[]> {
  // The URL parser keeps the brackets on an IPv6 literal.
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(bare);
  if (literal === 4 || literal === 6) {
    if (isPrivateAddress(bare, literal)) {
      throw AppError.forbidden(`${hostname} is not a public address.`);
    }
    return [{ address: bare, family: literal }];
  }

  let answers: ResolvedAddress[];
  try {
    answers = await resolve(hostname);
  } catch {
    throw AppError.unavailable(`${hostname} did not resolve.`);
  }
  if (answers.length === 0) {
    throw AppError.unavailable(`${hostname} did not resolve.`);
  }
  for (const { address, family } of answers) {
    if (isPrivateAddress(address, family)) {
      throw AppError.forbidden(
        `${hostname} resolves to a non-public address and was refused.`,
      );
    }
  }
  return answers;
}

/** Statuses whose response has no body, so a `Response` must be built without one. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Headers that frame the connection and the body, which this module owns: the
 * caller's are dropped, and the length is set from the body actually sent.
 */
const CONNECTION_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
];

/** fetch's limit on waiting for a silent upstream, kept so app code sees no change. */
const IDLE_TIMEOUT_MS = 300_000;

/** Undo a content coding, for the ones fetch undoes. */
function decoded(res: http.IncomingMessage, coding: string | null): Readable {
  const lenient = {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  };
  const noop = () => {};
  switch (coding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return pipeline(res, zlib.createGunzip(lenient), noop);
    case "deflate":
      return pipeline(res, zlib.createInflate(lenient), noop);
    case "br":
      return pipeline(
        res,
        zlib.createBrotliDecompress({
          flush: zlib.constants.BROTLI_OPERATION_FLUSH,
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        }),
        noop,
      );
    default:
      return res;
  }
}

function toResponse(res: http.IncomingMessage, url: URL, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    res.resume();
  } else {
    body = Readable.toWeb(
      decoded(res, headers.get("content-encoding")),
    ) as unknown as ReadableStream<Uint8Array>;
  }

  const response = new Response(body, {
    status,
    statusText: res.statusMessage,
    headers,
  });
  // fetch says which URL answered; app code may read it.
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}

/**
 * Send one request to `url`, connecting only to `addresses`.
 *
 * The socket goes to an address that was already checked, while the URL's
 * hostname still sets the Host header, the TLS server name, and the name the
 * certificate must match. Redirects are not followed — the caller re-checks
 * each hop — and what comes back is a standard `Response`, decoded as fetch
 * would, so app code cannot tell the difference.
 */
export async function requestPinned(
  url: URL,
  init: RequestInit,
  addresses: readonly ResolvedAddress[],
): Promise<Response> {
  if (addresses.length === 0) {
    throw AppError.unavailable(`${url.hostname} did not resolve.`);
  }

  // Let the platform's own Request normalise the method, headers and body —
  // including the content type of a form or a search-params body — exactly as
  // fetch would, then send what it produced.
  const request = new Request(url, { ...init, redirect: "manual" });
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  for (const name of CONNECTION_HEADERS) delete headers[name];
  // fetch's defaults, so an upstream sees the request it saw before.
  headers["accept"] ??= "*/*";
  headers["accept-encoding"] ??= "gzip, deflate, br";
  headers["user-agent"] ??= "node";
  if (body) headers["content-length"] = String(body.length);

  // Answers every lookup with the checked addresses. With `all` (Node's default
  // for happy-eyeballs) it offers all of them, so a host with both families
  // still falls back from one to the other — within what was checked.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const secure = url.protocol === "https:";

  return new Promise<Response>((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        host: hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        lookup: pinned,
        // TLS names the host the URL names — never a Host header the caller
        // set, and never an IP, which is not a server name.
        ...(secure ? { servername: isIP(hostname) ? "" : hostname } : {}),
        // Pooled sockets are keyed by host and port, not by the address they
        // reached, so a pooled one could skip this request's check.
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        try {
          resolve(toResponse(res, url, request.method));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    // Failures read as fetch's do: an abort as itself, anything else as
    // "fetch failed" with the transport's error as its cause.
    req.on("error", (err) => {
      reject(err.name === "AbortError" ? err : new TypeError("fetch failed", { cause: err }));
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`${url.hostname} did not respond in time.`));
    });
    req.end(body ?? undefined);
  });
}

export interface AppHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const MAX_REDIRECTS = 3;

export function createHttpClient(
  appSlug: string,
  declaredEgress: readonly string[],
): AppHttpClient {
  // A copy of its own, frozen: the list is checked on every request, and the
  // array passed in may be one the caller can still reach.
  const egress: readonly string[] = Object.freeze([...declaredEgress]);
  async function guardedFetch(url: string, init: RequestInit, hop: number): Promise<Response> {
    if (hop > MAX_REDIRECTS) {
      throw AppError.invalidInput(`Too many redirects fetching ${url}.`);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw AppError.invalidInput(`"${url}" is not a valid URL.`);
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw AppError.forbidden(
        `"${appSlug}" may not use the ${parsed.protocol} scheme.`,
      );
    }
    if (!hostAllowed(parsed.hostname, egress)) {
      throw AppError.forbidden(
        `"${appSlug}" is not allowed to reach ${parsed.hostname}. ` +
          `Add it to \`egress\` in app.json, or use a connector.`,
      );
    }

    // Resolved and checked once, then connected to exactly what was checked.
    // An IP literal (reachable only through a redirect, since the manifest
    // schema refuses one in `egress`) is checked directly.
    const addresses = await checkedAddresses(parsed.hostname);

    // Redirects are not followed by the request itself, so each hop goes back
    // through both checks. Following them automatically is how a validated
    // hostname ends up serving a request to the metadata endpoint.
    const response = await requestPinned(parsed, init, addresses);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel().catch(() => {});
      return guardedFetch(new URL(location, parsed).toString(), init, hop + 1);
    }

    return response;
  }

  return {
    fetch: (url, init = {}) => guardedFetch(url, init, 0),
  };
}
