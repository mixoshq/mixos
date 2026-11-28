/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Connectors in runners (Item 7b): what the platform holds in place of a
 * connector's own class when connectors run isolated.
 *
 * `constructConnector` (src/lib/connectors/loader.ts) returns a
 * RemoteConnector, and the rest of the platform uses it as it used the class:
 * it initializes it with the credentials it decrypted, binds a grant, allows
 * writes, wraps it in the facade and the telemetry. Each declared method,
 * `testConnection` and `handleWebhook` is a run in that connector's runner
 * (./connector-host.ts), with the credentials handed in. The keys, the
 * database and every other connector's credentials stay here.
 *
 * Two calls a connector runner may make, decided here:
 *
 *   - `http.fetch`: sent where the connector may go (./connector-relay.ts);
 *   - `grant.refresh`: renewed with the grant this instance was bound to, or
 *     the shared one, under its lock, as in process.
 *
 * Fails closed: on a host with the tier, a connector whose runner can't start
 * (no bundle, code that won't load) is unavailable. It never runs in process
 * instead.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { connectorRegistry } from "@/generated/connector-registry";
import { ConnectorError, type ConnectorErrorCategory } from "@/lib/connectors/errors";
import { connectorConfigState } from "@/lib/connectors/status";
import { REMOTE_CONNECTOR, type RemoteConnectorHooks } from "@/lib/connectors/remote-hooks";
import type { BaseConnector, ConnectorManifest, ConnectorTestResult, ConnectorWebhookEvent } from "@/lib/connectors/types";
import { relayConnectorFetch, relayedRequest, relayHosts } from "./connector-relay";
import { isolationSupport, Runner, RunnerCallRefusedError, RunnerUnavailableError, type RunnerCall } from "./supervisor";

/** Turns the isolated tier off where it exists, for an operator who must. */
export const ISOLATION_SETTING = "MIXOS_ISOLATION";

/** Whether connectors run in runners on this host, and if not, why. */
export function connectorIsolation(): { on: true } | { on: false; reason: string } {
  if ((process.env[ISOLATION_SETTING] ?? "").trim().toLowerCase() === "off") {
    return { on: false, reason: `turned off by the operator (${ISOLATION_SETTING}=off)` };
  }
  const support = isolationSupport();
  if (!support.supported) return { on: false, reason: support.reason };
  if (process.env.NODE_ENV !== "production") {
    return { on: false, reason: "a development server runs connectors in its own process" };
  }
  return { on: true };
}

let bundleRoot: string | null = null;

/** For tests, each in a folder of its own: where runner bundles are read from. Null is the build's. */
export function useRunnerBundleRoot(dir: string | null): void {
  bundleRoot = dir;
}

/** Where a connector's runner bundle is: built by scripts/build-runner-bundles.ts. */
export function connectorBundlePath(name: string): string {
  return path.join(bundleRoot ?? path.join(process.cwd(), "runner-bundles"), "connectors", name, "bundle.mjs");
}

/** How long one connector call may take in its runner, retries included. */
export const CONNECTOR_RUN_TIMEOUT_MS = 120_000;

const CATEGORIES = new Set<ConnectorErrorCategory>([
  "unconfigured",
  "auth_failed",
  "forbidden",
  "rate_limited",
  "not_found",
  "invalid_request",
  "conflict",
  "payload_too_large",
  "timeout",
  "upstream_error",
  "network_error",
  "unexpected_response",
]);

function manifestOf(name: string): ConnectorManifest | undefined {
  return connectorRegistry.find((c) => c.name === name);
}

/**
 * The runner's error, as the platform knows it: a ConnectorError rebuilt as
 * a real one (with the connector's name from here, never the runner's word),
 * anything else as itself.
 */
export function asConnectorError(connector: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const e = error as Error & Record<string, unknown>;
  if (e.name !== "ConnectorError" || typeof e.category !== "string" || !CATEGORIES.has(e.category as ConnectorErrorCategory)) {
    return error;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return new ConnectorError({
    category: e.category as ConnectorErrorCategory,
    connectorName: connector,
    subject: str(e.subject),
    status: num(e.status),
    retryAfterMs: num(e.retryAfterMs),
    attempts: num(e.attempts) ?? undefined,
    upstreamRequestId: str(e.upstreamRequestId) ?? null,
    userMessage: str(e.userMessage),
    adminHint: str(e.adminHint),
  });
}

// Symbols, not names, so no method a connector declares can collide with them.
const RUN = Symbol("run");
const RELAY_CREDENTIALS = Symbol("relayCredentials");
const REFRESH = Symbol("refreshGrant");

// ── The instances: so a runner's call names one, and only its connector's ──

const live = new Map<string, WeakRef<RemoteConnector>>();
const finalizer = new FinalizationRegistry<string>((id) => live.delete(id));

function instanceFor(id: unknown, connector: string): RemoteConnector | null {
  if (typeof id !== "string") return null;
  const found = live.get(id)?.deref();
  return found && found.name === connector ? found : null;
}

/** Decide a connector runner's call. `run.subject` is the connector whose runner asked. */
export async function connectorRunnerCall({ run, op, args }: RunnerCall): Promise<unknown> {
  const connector = run.subject;
  const manifest = manifestOf(connector);
  if (!manifest) throw new RunnerCallRefusedError(`${connector} isn't a registered connector.`);
  switch (op) {
    case "http.fetch": {
      const request = relayedRequest(args);
      const instance = instanceFor(request.instance, connector);
      return relayConnectorFetch(connector, relayHosts(manifest, instance?.[RELAY_CREDENTIALS]() ?? {}), request);
    }
    case "grant.refresh": {
      const a = (args ?? {}) as { instance?: unknown; rejected?: unknown };
      const instance = instanceFor(a.instance, connector);
      if (!instance) throw new RunnerCallRefusedError("That connector instance has ended.");
      return instance[REFRESH](typeof a.rejected === "string" ? a.rejected : undefined);
    }
    default:
      throw new RunnerCallRefusedError(`A connector may not ask for ${String(op).slice(0, 40)}.`);
  }
}

// ── The runners: one per connector, kept on globalThis across dev reloads ──

const globalForRunners = globalThis as unknown as { __mixosConnectorRunners?: Map<string, Runner> };

function runnerFor(name: string): Runner {
  const runners = (globalForRunners.__mixosConnectorRunners ??= new Map());
  let runner = runners.get(name);
  if (!runner) {
    runner = new Runner({ id: `connector:${name}`, bundle: connectorBundlePath(name), onCall: connectorRunnerCall });
    runners.set(name, runner);
  }
  return runner;
}

/** Stop every connector runner: for tests, and a process going down. */
export async function stopConnectorRunners(): Promise<void> {
  const runners = globalForRunners.__mixosConnectorRunners;
  if (!runners) return;
  await Promise.all([...runners.values()].map((r) => r.stop()));
  runners.clear();
}

/** One connector, run in its runner. */
export class RemoteConnector implements BaseConnector {
  readonly name: string;
  #credentials: Record<string, string> = {};
  #writes = false;
  #grant: ((rejected?: string) => Promise<Record<string, string>>) | null = null;
  readonly #instance = randomBytes(16).toString("base64url");
  readonly #manifest: ConnectorManifest | undefined;

  constructor(name: string) {
    this.name = name;
    this.#manifest = manifestOf(name);
    live.set(this.#instance, new WeakRef(this));
    finalizer.register(this, this.#instance);
    const hooks: RemoteConnectorHooks = {
      bindGrant: (refresh) => {
        if (this.#grant) throw new Error(`connector "${name}" already has a grant bound.`);
        this.#grant = refresh;
      },
      allowWrites: () => {
        this.#writes = true;
      },
    };
    Object.defineProperty(this, REMOTE_CONNECTOR, { value: Object.freeze(hooks), enumerable: false });
  }

  /** As HttpConnector decides it, from the manifest and the credentials. */
  get configured(): boolean {
    return (
      connectorConfigState(this.#manifest?.auth ?? { strategy: "none" }, this.#credentials, this.#manifest?.credentialFields) ===
      "ready"
    );
  }

  initialize(credentials: Record<string, string>): void {
    this.#credentials = { ...credentials };
  }

  /** The base URL an admin entered, for where the relay lets it go. */
  [RELAY_CREDENTIALS](): Record<string, string> {
    return this.#credentials.baseUrl ? { baseUrl: this.#credentials.baseUrl } : {};
  }

  /** Renew the grant this instance was bound to, or the shared one, as HttpConnector would. */
  async [REFRESH](rejected?: string): Promise<Record<string, string>> {
    let fresh: Record<string, string>;
    if (this.#grant) {
      fresh = await this.#grant(rejected);
    } else {
      const { refreshConnectorTokens } = await import("@/lib/connectors/config");
      const { TOKEN_SKEW_MS } = await import("@/lib/connectors/http-connector");
      fresh = await refreshConnectorTokens({
        connectorName: this.name,
        subject: this.#manifest?.displayName ?? this.name,
        policy: this.#manifest?.auth ?? { strategy: "none" },
        skewMs: TOKEN_SKEW_MS,
        rejected,
      });
    }
    this.#credentials = { ...this.#credentials, ...fresh };
    return fresh;
  }

  async testConnection(): Promise<ConnectorTestResult> {
    return (await this[RUN]("test", "testConnection", {})) as ConnectorTestResult;
  }

  /** A run in the connector's runner, failing closed. */
  async [RUN](kind: string, name: string, extra: Record<string, unknown>): Promise<unknown> {
    if (!existsSync(connectorBundlePath(this.name))) {
      throw new RunnerUnavailableError(
        `${this.name} has no runner bundle in this build, so it isn't run at all. Build with \`npm run build\`.`,
      );
    }
    try {
      return await runnerFor(this.name).run(
        kind,
        name,
        { instance: this.#instance, credentials: this.#credentials, writes: this.#writes, ...extra },
        { subject: this.name, userId: null, readOnly: false },
        { timeoutMs: CONNECTOR_RUN_TIMEOUT_MS },
      );
    } catch (error) {
      throw asConnectorError(this.name, error);
    }
  }
}

/**
 * A RemoteConnector for one connector, with its declared methods on its
 * prototype, as a class's would be, and `handleWebhook` only where its
 * manifest has a webhook. The facade finds them as it finds a class's.
 */
export function createRemoteConnector(name: string): BaseConnector {
  const manifest = manifestOf(name);
  class Declared extends RemoteConnector {}
  for (const { method } of manifest?.telemetry ?? []) {
    if (method in RemoteConnector.prototype || method === "constructor") continue;
    Object.defineProperty(Declared.prototype, method, {
      value: function (this: RemoteConnector, ...args: unknown[]) {
        return this[RUN]("method", method, { args });
      },
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  if (manifest?.webhook) {
    Object.defineProperty(Declared.prototype, "handleWebhook", {
      value: async function (this: RemoteConnector, event: ConnectorWebhookEvent) {
        await this[RUN]("webhook", "handleWebhook", { event });
      },
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  return new Declared(name);
}
