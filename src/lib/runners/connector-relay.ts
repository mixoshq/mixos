/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A connector runner's requests, made by the platform (Item 7b). A runner has
 * no network: its `fetch` is a call here (./connector-host.ts), and this sends
 * it only where the connector said it would go.
 *
 *   - **The hosts its manifest names**: `http.baseUrl`, `http.hosts`,
 *     `auth.tokenUrl` and `auth.authorizeUrl`. Over https, and only to public addresses: every
 *     address a name resolves to is checked, and the request goes to exactly
 *     the address checked (requestPinned, src/lib/apps/http.ts), so a name
 *     can't be pointed at the cloud metadata endpoint or the private network.
 *   - **The base URL an admin entered** (the `baseUrl` credential): http or
 *     https, private addresses included. An admin pointing a connector at a
 *     self-hosted service on their own network is the one way a connector
 *     reaches it.
 *
 * Redirects are followed by hand, up to five, each hop checked again. The
 * answer is read whole, up to RELAY_MAX_BYTES.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { checkedAddresses, requestPinned, type ResolvedAddress } from "@/lib/apps/http";
import type { ConnectorManifest } from "@/lib/connectors/types";
import type { RelayedRequest, RelayedResponse } from "./connector-host";

/** The most a relayed answer may be. A connector's own cap (`maxBytes`) is lower. */
export const RELAY_MAX_BYTES = 10 * 1024 * 1024;
export const RELAY_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** A request the relay won't send. The runner's fetch rejects with it. */
export class ConnectorRelayRefusedError extends Error {
  override name = "ConnectorRelayRefusedError";
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Where a connector may send requests. */
export interface RelayHosts {
  /** From its manifest: https and public addresses only. */
  declared: ReadonlySet<string>;
  /** From the admin's base URL credential, if any: http too, and private addresses. */
  admin: string | null;
}

export function relayHosts(manifest: Pick<ConnectorManifest, "http" | "auth">, credentials: Record<string, string>): RelayHosts {
  const declared = new Set<string>();
  const auth = manifest.auth as { tokenUrl?: string; authorizeUrl?: string } | undefined;
  for (const url of [manifest.http?.baseUrl, auth?.tokenUrl, auth?.authorizeUrl]) {
    const host = hostOf(url);
    if (host) declared.add(host);
  }
  for (const host of manifest.http?.hosts ?? []) declared.add(host.toLowerCase());
  return { declared, admin: hostOf(credentials.baseUrl) };
}

async function addressesFor(url: URL, hosts: RelayHosts, connector: string): Promise<ResolvedAddress[]> {
  const host = url.hostname.toLowerCase();
  if (hosts.admin && host === hosts.admin) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ConnectorRelayRefusedError(`${connector} may not use the ${url.protocol} scheme.`);
    }
    const bare = host.replace(/^\[(.*)\]$/, "$1");
    const family = isIP(bare);
    if (family === 4 || family === 6) return [{ address: bare, family }];
    const answers = await lookup(host, { all: true });
    return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  }
  if (!hosts.declared.has(host)) {
    throw new ConnectorRelayRefusedError(
      `${connector} may not reach ${host}: it isn't in the connector's manifest, or the base URL an admin entered.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new ConnectorRelayRefusedError(`${connector} reaches ${host} over https only.`);
  }
  try {
    return await checkedAddresses(url.hostname);
  } catch (error) {
    throw new ConnectorRelayRefusedError(error instanceof Error ? error.message : `${host} was refused.`);
  }
}

async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RELAY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ConnectorRelayRefusedError(`The answer is over ${RELAY_MAX_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectorRelayRefusedError(`${what} didn't answer within ${ms} ms.`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Validate what a runner sent, since a runner is the connector's code. */
export function relayedRequest(args: unknown): RelayedRequest {
  const a = args as Partial<RelayedRequest> | null;
  if (!a || typeof a !== "object") throw new ConnectorRelayRefusedError("A request needs a URL and a method.");
  if (typeof a.url !== "string" || a.url.length > 8192) throw new ConnectorRelayRefusedError("A request needs a URL.");
  if (typeof a.method !== "string" || !/^[A-Z]{1,16}$/.test(a.method)) throw new ConnectorRelayRefusedError("A request needs a method.");
  if (!Array.isArray(a.headers) || a.headers.length > 200 || !a.headers.every((h) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === "string"))) {
    throw new ConnectorRelayRefusedError("A request's headers are name and value pairs.");
  }
  if (a.body !== null && a.body !== undefined && !(a.body instanceof Uint8Array)) {
    throw new ConnectorRelayRefusedError("A request's body is bytes.");
  }
  const redirect = a.redirect === "manual" || a.redirect === "error" ? a.redirect : "follow";
  return {
    instance: typeof a.instance === "string" ? a.instance : "",
    url: a.url,
    method: a.method,
    headers: a.headers as Array<[string, string]>,
    body: a.body ?? null,
    redirect,
  };
}

/** Send one of a connector's requests, where it may go. */
export async function relayConnectorFetch(
  connector: string,
  hosts: RelayHosts,
  request: RelayedRequest,
): Promise<RelayedResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ConnectorRelayRefusedError(`"${request.url.slice(0, 200)}" is not a URL.`);
  }
  let method = request.method;
  let body: Uint8Array | null = request.body;
  let headers = request.headers;
  for (let hop = 0; ; hop++) {
    const addresses = await addressesFor(url, hosts, connector);
    const init: RequestInit = {
      method,
      headers,
      body: body && method !== "GET" && method !== "HEAD" ? Buffer.from(body) : undefined,
    };
    const response = await withTimeout(requestPinned(url, init, addresses), RELAY_TIMEOUT_MS, url.hostname);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location && request.redirect !== "manual") {
      await response.body?.cancel().catch(() => {});
      if (request.redirect === "error") throw new ConnectorRelayRefusedError(`${url.hostname} redirected, and the request said not to follow.`);
      if (hop >= MAX_REDIRECTS) throw new ConnectorRelayRefusedError(`Too many redirects from ${url.hostname}.`);
      const next = new URL(location, url);
      // As fetch does: credentials don't follow a redirect to another origin.
      if (next.origin !== url.origin) {
        headers = headers.filter(([k]) => !["authorization", "cookie", "proxy-authorization"].includes(k.toLowerCase()));
      }
      url = next;
      // As fetch does: a 303, or a 301/302 after a POST, becomes a GET without a body.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
      }
      continue;
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: await withTimeout(readCapped(response), RELAY_TIMEOUT_MS, url.hostname),
    };
  }
}
