/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector side of a connector runner (Item 7b). Bundled with one
 * connector's code (scripts/build-runner-bundles.ts) and run by
 * runner/bootstrap.mjs, under Node's permission model, with no network, no
 * secrets and no database.
 *
 * The platform holds a RemoteConnector (./remote-connector.ts) where it would
 * have held the connector. Each method call, Verify connection and webhook is
 * a run here: this builds the connector's own class with the credentials the
 * platform hands in, and calls it. Two things the class does reach back to the
 * platform, as calls under the run's capability:
 *
 *   - **fetch**: every request goes through `http.fetch`, and the platform
 *     sends it only to a host the connector's manifest names, or the base URL
 *     an admin entered (./connector-relay.ts).
 *   - **a token renewal**: a three-legged grant is renewed by the platform,
 *     under its lock, through `grant.refresh`. The class never reaches the
 *     database or the keys.
 *
 * One connector object per platform-side instance (one context build), kept
 * while it is used, so a client-credentials token is minted once per request
 * as it was in process, not once per call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { BaseConnector } from "@/lib/connectors/types";

/** The runner's way back to the platform, for one run (runner/bootstrap.mjs). */
export interface RunnerHost {
  call(op: string, args?: unknown): Promise<unknown>;
  signal: AbortSignal;
}

/** What the platform hands a connector run. */
export interface ConnectorRunInput {
  /** The platform's id for one connector object. */
  instance: string;
  credentials: Record<string, string>;
  /** Whether this install allows the connector to change data. */
  writes: boolean;
  args?: unknown[];
  event?: unknown;
}

export const CONNECTOR_RUN_KINDS = ["method", "test", "webhook", "release"] as const;

const current = new AsyncLocalStorage<RunnerHost>();

function currentHost(what: string): RunnerHost {
  const host = current.getStore();
  if (!host) throw new TypeError(`${what} outside a run: a connector reaches nothing between calls`);
  return host;
}

/** The wire form of a relayed request, and its answer (./connector-relay.ts). */
export interface RelayedRequest {
  instance: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
  redirect: "follow" | "manual" | "error";
}

export interface RelayedResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array | null;
}

const BODYLESS = new Set([101, 103, 204, 205, 304]);

function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** fetch, as the connector's code sees it: a call to the platform. */
function relayFetch(instance: () => string) {
  return async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const host = currentHost("fetch");
    const request = new Request(input, init);
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw signal.reason;
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const wire: RelayedRequest = {
      instance: instance(),
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
      redirect: (init?.redirect ?? "follow") as RelayedRequest["redirect"],
    };
    const call = host.call("http.fetch", wire) as Promise<RelayedResponse>;
    const answer = signal ? await Promise.race([call, abortedBy(signal)]) : await call;
    return new Response(BODYLESS.has(answer.status) ? null : ((answer.body ?? null) as BodyInit | null), {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers,
    });
  };
}

/** Whether a value can leave the runner as itself. A Response, a stream or a function can't. */
export function crossable(value: unknown, depth = 0): string | null {
  if (depth > 64) return "nested more than 64 deep";
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return null;
    case "function":
      return "a function";
    case "symbol":
      return "a symbol";
  }
  if (value instanceof Date || value instanceof Uint8Array || value instanceof Error) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const why = crossable(v, depth + 1);
      if (why) return why;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "an object of a class";
    return `a ${name}`;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const why = crossable(v, depth + 1);
    if (why) return why;
  }
  return null;
}

/** A method of the connector's: a function-valued data property, on the class or the instance. */
function methodOf(connector: object, name: string): ((...a: unknown[]) => unknown) | undefined {
  for (let o: object | null = connector; o !== null && o !== Object.prototype; o = Reflect.getPrototypeOf(o)) {
    const d = Reflect.getOwnPropertyDescriptor(o, name);
    if (d) return "value" in d && typeof d.value === "function" ? d.value : undefined;
  }
  return undefined;
}

const MAX_INSTANCES = 500;
const IDLE_MS = 10 * 60_000;

interface Held {
  connector: Served;
  fingerprint: string;
  usedAt: number;
}

/** A connector's class, with the members the platform calls when they exist. */
type Served = BaseConnector & {
  testConnection?: () => Promise<unknown>;
  handleWebhook?: (event: unknown) => Promise<void>;
};
type ConnectorClass = new () => Served;

/** The runner bundle's run(): one connector's class, served. */
export function serveConnector(mod: Record<string, unknown>) {
  const Class = (mod.default ??
    mod[Object.keys(mod).find((k) => typeof mod[k] === "function")!]) as ConnectorClass | undefined;
  if (typeof Class !== "function") throw new Error("the connector's module exports no class");
  const Connector: ConnectorClass = Class;

  const held = new Map<string, Held>();
  const instanceOf = new AsyncLocalStorage<string>();
  globalThis.fetch = relayFetch(() => instanceOf.getStore() ?? "");

  function evict(now: number) {
    for (const [id, h] of held) if (now - h.usedAt > IDLE_MS) held.delete(id);
    while (held.size >= MAX_INSTANCES) held.delete(held.keys().next().value as string);
  }

  async function connectorFor(input: ConnectorRunInput): Promise<Served> {
    const now = Date.now();
    const fingerprint = JSON.stringify([input.credentials, input.writes]);
    const existing = held.get(input.instance);
    if (existing && existing.fingerprint === fingerprint) {
      existing.usedAt = now;
      return existing.connector;
    }
    evict(now);
    const connector = new Connector();
    if (input.writes) HttpConnector.allowWrites(connector);
    // A three-legged grant is renewed by the platform, under its lock.
    HttpConnector.bindUserGrant(connector, async (rejected) =>
      (await currentHost("A token renewal").call("grant.refresh", {
        instance: input.instance,
        rejected: rejected ?? null,
      })) as Record<string, string>,
    );
    await connector.initialize({ ...input.credentials });
    held.set(input.instance, { connector, fingerprint, usedAt: now });
    return connector;
  }

  return async function run(kind: string, name: string, input: ConnectorRunInput, host: RunnerHost): Promise<unknown> {
    if (!input || typeof input.instance !== "string" || !input.credentials || typeof input.credentials !== "object") {
      throw new TypeError("a connector run needs an instance and credentials");
    }
    if (kind === "release") {
      held.delete(input.instance);
      return null;
    }
    return current.run(host, () =>
      instanceOf.run(input.instance, async () => {
        const connector = await connectorFor(input);
        let value: unknown;
        switch (kind) {
          case "method": {
            const fn = methodOf(connector, name);
            if (!fn) throw new TypeError(`${name} is not a method of this connector`);
            value = await fn.apply(connector, Array.isArray(input.args) ? input.args : []);
            break;
          }
          case "test":
            if (typeof connector.testConnection !== "function") throw new TypeError("this connector has no testConnection()");
            value = await connector.testConnection();
            break;
          case "webhook":
            if (typeof connector.handleWebhook !== "function") throw new TypeError("this connector handles no webhooks");
            await connector.handleWebhook(input.event);
            return null;
          default:
            throw new TypeError(`no connector run of kind ${kind}`);
        }
        const why = crossable(value);
        if (why) {
          throw new TypeError(
            `${name} returned ${why}, which can't leave the connector's runner. A connector running isolated returns data: ` +
              `plain objects, arrays, strings, numbers, dates and bytes.`,
          );
        }
        return value;
      }),
    );
  };
}
