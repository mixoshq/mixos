/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The runner supervisor (Items 5b and 7b, step 1 of
 * docs/plans/20261128_0146-out-of-process-runners.md).
 *
 * A runner is a Node process for one Registry app or one connector, started
 * from runner/bootstrap.mjs under Node's permission model with an empty
 * environment: no network, no child processes, no workers, no file writes,
 * and no file reads beyond its own code. The platform hands it runs over a
 * pipe and answers the calls it makes inside them. Every one of those calls
 * is checked here, against the run it belongs to: the platform is the only
 * enforcement point, and a runner holds nothing it could misuse on its own.
 *
 * Two layers:
 *
 *   - RunnerConnection is the protocol, with no process: the runs, their
 *     capabilities, and the calls. Tests drive it with frames.
 *   - Runner is the process: starting it, restarting it with backoff, and
 *     stopping one that stops answering or sits idle. It never falls back to
 *     running the code in this process. A runner that can't start leaves its
 *     app or connector unavailable (fail closed).
 *
 * The capability is a random token minted per run and kept in this process,
 * in the run's own connection. A call is answered only if its token names a
 * run that this runner is doing right now, so a runner acts only inside a run
 * the platform started, as that run's user, read-only when the run is, and
 * only until the run ends. A token from another runner names nothing here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Duplex, Readable } from "node:stream";
import { encodeFrame, FrameError, FrameReader } from "../../../runner/frames.mjs";

/** Who a run is for. Every call made inside it is checked against this. */
export interface RunScope {
  /** Whose runner it is: the app's slug or the connector's name. */
  subject: string;
  /** The person the run acts for; null for a job, a sync or a webhook. */
  userId: string | null;
  /** An MCP tool or a search handler: the calls inside it may not write. */
  readOnly: boolean;
}

/** A call a runner made, for the platform to decide. */
export interface RunnerCall {
  run: RunScope & { runId: string };
  op: string;
  args: unknown;
}

export type CallHandler = (call: RunnerCall) => Promise<unknown>;

/** The runner isn't there: it couldn't start, or is waiting to restart. */
export class RunnerUnavailableError extends Error {
  override name = "RunnerUnavailableError";
}

/** A run went past its time and was given up on. */
export class RunnerTimeoutError extends Error {
  override name = "RunnerTimeoutError";
}

/** The runner stopped while the run was in it. */
export class RunnerCrashedError extends Error {
  override name = "RunnerCrashedError";
}

/** A runner broke the protocol; the platform stops it. */
export class RunnerProtocolError extends Error {
  override name = "RunnerProtocolError";
}

/** What a runner is told when the platform refuses one of its calls. */
export class RunnerCallRefusedError extends Error {
  override name = "RunnerCallRefusedError";
}

/** The most calls one run may have waiting at once. */
export const MAX_CALLS_PER_RUN = 32;

const MAX_ID = 64;
const MAX_TOKEN = 128;

interface PendingRun {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cap: string;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveRun extends RunScope {
  runId: string;
  expiresAt: number;
  inFlight: number;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** The protocol with one runner, without the process. */
export class RunnerConnection {
  readonly #runs = new Map<string, PendingRun>();
  readonly #caps = new Map<string, LiveRun>();
  readonly #pings = new Map<string, () => void>();
  #nextRun = 0;
  #nextPing = 0;
  #closed: Error | null = null;

  constructor(
    private readonly opts: {
      id: string;
      write: (frame: Buffer) => void;
      onCall: CallHandler;
      maxCallsPerRun?: number;
      now?: () => number;
    },
  ) {}

  /** Runs waiting for their answer. */
  get pending(): number {
    return this.#runs.size;
  }

  #now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  #send(message: Record<string, unknown>): void {
    this.opts.write(encodeFrame(message));
  }

  /** Hand the runner a run, and wait for its answer. */
  run(kind: string, name: string, input: unknown, scope: RunScope, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const runId = `r${++this.#nextRun}`;
    const cap = randomBytes(32).toString("base64url");
    this.#caps.set(cap, { ...scope, runId, expiresAt: this.#now() + timeoutMs, inFlight: 0 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#end(runId)) return;
        try {
          this.#send({ t: "cancel", id: runId });
        } catch {
          // The pipe is gone; the exit handler says so.
        }
        reject(new RunnerTimeoutError(`${this.opts.id} didn't finish ${kind} ${name} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#runs.set(runId, { resolve, reject, cap, timer });
      try {
        this.#send({ t: "run", id: runId, kind, name, input: input === undefined ? null : input, cap });
      } catch (error) {
        this.#end(runId);
        reject(asError(error, "couldn't send the run"));
      }
    });
  }

  /** End a run: its capability names nothing from now on. */
  #end(runId: string): PendingRun | null {
    const run = this.#runs.get(runId);
    if (!run) return null;
    clearTimeout(run.timer);
    this.#runs.delete(runId);
    this.#caps.delete(run.cap);
    return run;
  }

  /** Ask whether the runner's event loop is still turning. */
  ping(timeoutMs: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const id = `p${++this.#nextPing}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pings.delete(id);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.#pings.set(id, () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        this.#send({ t: "ping", id });
      } catch {
        this.#pings.delete(id);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /**
   * A frame from the runner. Throws a RunnerProtocolError for one that breaks
   * the protocol, and the runner is stopped: it is either broken or hostile.
   */
  receive(frame: Record<string, unknown>): void {
    switch (frame.t) {
      case "done": {
        if (!shortString(frame.id, MAX_ID)) throw new RunnerProtocolError("done without an id");
        // A run already given up on (timed out) is no longer here.
        const run = this.#end(frame.id);
        if (!run) return;
        if (frame.ok === true) run.resolve(frame.value);
        else run.reject(asError(frame.error, `${this.opts.id} failed the run`));
        return;
      }
      case "call": {
        if (!shortString(frame.id, MAX_ID)) throw new RunnerProtocolError("call without an id");
        void this.#call(frame.id, frame.cap, frame.op, frame.args);
        return;
      }
      case "pong": {
        const id = String(frame.id);
        const settle = this.#pings.get(id);
        this.#pings.delete(id);
        settle?.();
        return;
      }
      default:
        throw new RunnerProtocolError(`unexpected frame ${JSON.stringify(String(frame.t)).slice(0, 40)}`);
    }
  }

  async #call(id: string, cap: unknown, op: unknown, args: unknown): Promise<void> {
    const live = shortString(cap, MAX_TOKEN) ? this.#caps.get(cap) : undefined;
    if (!live || this.#now() > live.expiresAt) {
      this.#reply(id, false, new RunnerCallRefusedError("This call isn't inside a run the platform started."));
      return;
    }
    if (!shortString(op, MAX_TOKEN)) {
      this.#reply(id, false, new RunnerCallRefusedError("A call needs an operation."));
      return;
    }
    if (live.inFlight >= (this.opts.maxCallsPerRun ?? MAX_CALLS_PER_RUN)) {
      this.#reply(id, false, new RunnerCallRefusedError("Too many calls at once in one run."));
      return;
    }
    live.inFlight++;
    try {
      const value = await this.opts.onCall({
        run: { runId: live.runId, subject: live.subject, userId: live.userId, readOnly: live.readOnly },
        op,
        args,
      });
      this.#reply(id, true, value);
    } catch (error) {
      this.#reply(id, false, asError(error, "The call failed."));
    } finally {
      live.inFlight--;
    }
  }

  #reply(id: string, ok: boolean, payload: unknown): void {
    try {
      this.#send(ok ? { t: "reply", id, ok, value: payload === undefined ? null : payload } : { t: "reply", id, ok, error: payload });
    } catch {
      try {
        this.#send({ t: "reply", id, ok: false, error: new RunnerCallRefusedError("The answer is too large to send.") });
      } catch {
        // The pipe is gone; the exit handler says so.
      }
    }
  }

  /** The runner is gone: every run waiting on it fails, and every capability ends. */
  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const runId of [...this.#runs.keys()]) this.#end(runId)?.reject(error);
    this.#caps.clear();
    for (const settle of this.#pings.values()) settle();
    this.#pings.clear();
  }
}

/** Whether this host can run runners at all. */
export function isolationSupport(): { supported: true } | { supported: false; reason: string } {
  const major = Number.parseInt(process.versions.node, 10);
  if (!(major >= 25)) {
    return {
      supported: false,
      reason: `Node ${process.versions.node} has no network permission; runners need Node 25 or later`,
    };
  }
  if (process.env.VERCEL) {
    return { supported: false, reason: "Vercel runs each request in a short-lived function, with no room for a runner" };
  }
  return { supported: true };
}

/** Where runner/bootstrap.mjs and runner/frames.mjs are: the repository's, or the image's. */
export function runnerDir(): string {
  return path.join(process.cwd(), "runner");
}

/** Exit code a runner uses when it refuses to start (runner/bootstrap.mjs). */
const REFUSED = 78;

export interface RunnerOptions {
  /** For logs and errors: "app:<slug>" or "connector:<name>". */
  id: string;
  /** The code it loads: an .mjs file whose folder holds nothing else it shouldn't read. */
  bundle: string;
  /** Decides each call the runner makes. */
  onCall: CallHandler;
  /** Its heap, in MB. */
  memoryMb?: number;
  /** How long it may take to load its code. */
  startTimeoutMs?: number;
  /** How long it stays up with nothing to do. */
  idleMs?: number;
  /** How often it is asked whether it is still answering while a run is in it. */
  heartbeatMs?: number;
  /** Where its output and the supervisor's notes about it go. */
  log?: (line: string) => void;
}

type State = "stopped" | "starting" | "ready";

/** The delay before a start is tried again, after this many failures in a row. */
export function backoffMs(failures: number): number {
  if (failures <= 1) return 0;
  return Math.min(60_000, 1000 * 2 ** (failures - 2));
}

/** A runner sitting up this long has its failures forgotten. */
const STABLE_MS = 60_000;

/** One runner process, started on first use. */
export class Runner {
  #state: State = "stopped";
  #child: ChildProcess | null = null;
  #conn: RunnerConnection | null = null;
  #starting: Promise<RunnerConnection> | null = null;
  #failures = 0;
  #retryAt = 0;
  #readyAt = 0;
  #stopping = false;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #pinging = false;

  constructor(private readonly opts: RunnerOptions) {}

  get state(): State {
    return this.#state;
  }

  /** The process id while it is up: for tests and the admin pages. */
  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  #log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(`[runner ${this.opts.id}] ${line}`);
  }

  /** Do one run in the runner, starting it if need be. */
  async run(
    kind: string,
    name: string,
    input: unknown,
    scope: RunScope,
    options: { timeoutMs: number },
  ): Promise<unknown> {
    const conn = await this.#ready();
    this.#clearIdle();
    try {
      return await conn.run(kind, name, input, scope, options.timeoutMs);
    } finally {
      if (conn.pending === 0) this.#scheduleIdle();
    }
  }

  /** Stop it. The next run starts it again. */
  async stop(): Promise<void> {
    this.#clearIdle();
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.#stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    force.unref?.();
    await exited;
    clearTimeout(force);
  }

  #ready(): Promise<RunnerConnection> {
    if (this.#state === "ready" && this.#conn) return Promise.resolve(this.#conn);
    if (this.#starting) return this.#starting;
    const wait = this.#retryAt - Date.now();
    if (wait > 0) {
      return Promise.reject(
        new RunnerUnavailableError(
          `${this.opts.id} is unavailable after ${this.#failures} failure(s) in a row; it is tried again in ${Math.ceil(wait / 1000)} s`,
        ),
      );
    }
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  #failed(): void {
    this.#failures++;
    this.#retryAt = Date.now() + backoffMs(this.#failures);
  }

  #start(): Promise<RunnerConnection> {
    const support = isolationSupport();
    if (!support.supported) return Promise.reject(new RunnerUnavailableError(support.reason));
    const dir = runnerDir();
    const bundle = path.resolve(this.opts.bundle);
    const args = [
      "--permission",
      `--allow-fs-read=${dir}`,
      `--allow-fs-read=${path.dirname(bundle)}`,
      `--max-old-space-size=${this.opts.memoryMb ?? 256}`,
      path.join(dir, "bootstrap.mjs"),
      bundle,
    ];
    this.#state = "starting";
    this.#stopping = false;
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        // Nothing at all: the empty environment is the point. (Next types
        // ProcessEnv as always having NODE_ENV; a runner has none.)
        env: {} as NodeJS.ProcessEnv,
        cwd: path.dirname(bundle),
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#state = "stopped";
      this.#failed();
      return Promise.reject(new RunnerUnavailableError(`${this.opts.id} couldn't start: ${asError(error, "spawn failed").message}`));
    }
    this.#child = child;
    const pipe = child.stdio[3] as Duplex;
    // A write to a runner that just exited is an EPIPE here; the exit handler
    // is what reports it, so the platform must not crash on it.
    pipe.on("error", () => {});
    this.#forward(child.stdout);
    this.#forward(child.stderr);
    const conn = new RunnerConnection({ id: this.opts.id, write: (b) => void pipe.write(b), onCall: this.opts.onCall });

    return new Promise<RunnerConnection>((resolve, reject) => {
      let started = false;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.#failed();
        reject(error);
      };
      const startTimer = setTimeout(() => {
        fail(new RunnerUnavailableError(`${this.opts.id} didn't start within ${this.opts.startTimeoutMs ?? 10_000} ms`));
        child.kill("SIGKILL");
      }, this.opts.startTimeoutMs ?? 10_000);
      startTimer.unref?.();

      const reader = new FrameReader((frame) => {
        if (started) {
          conn.receive(frame);
          return;
        }
        if (frame.t === "ready") {
          started = true;
          settled = true;
          clearTimeout(startTimer);
          this.#state = "ready";
          this.#conn = conn;
          this.#readyAt = Date.now();
          this.#startHeartbeat(conn, child);
          this.#scheduleIdle();
          resolve(conn);
          return;
        }
        if (frame.t === "failed") {
          const why = asError(frame.error, "unknown error").message;
          this.#log(`couldn't load its code: ${why}`);
          fail(new RunnerUnavailableError(`${this.opts.id} couldn't load its code: ${why}`));
          return;
        }
        throw new RunnerProtocolError("a frame before ready");
      });
      pipe.on("data", (chunk: Buffer) => {
        try {
          reader.push(chunk);
        } catch (error) {
          const why = error instanceof FrameError || error instanceof RunnerProtocolError ? error.message : String(error);
          this.#log(`broke the protocol (${why}); stopping it`);
          child.kill("SIGKILL");
        }
      });

      child.on("error", (error) => {
        fail(new RunnerUnavailableError(`${this.opts.id} couldn't start: ${error.message}`));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(startTimer);
        this.#stopHeartbeat();
        this.#clearIdle();
        const how = code === REFUSED ? "refused to start (see its log)" : code !== null ? `exit ${code}` : `signal ${signal}`;
        const error = started
          ? new RunnerCrashedError(`${this.opts.id} stopped (${how})`)
          : new RunnerUnavailableError(`${this.opts.id} couldn't start (${how})`);
        conn.close(error);
        if (this.#child === child) {
          this.#child = null;
          this.#conn = null;
          this.#state = "stopped";
        }
        if (!started) {
          fail(error);
        } else if (!this.#stopping) {
          if (Date.now() - this.#readyAt > STABLE_MS) this.#failures = 0;
          this.#failed();
          this.#log(`stopped (${how}); the next run starts it again`);
        }
        this.#stopping = false;
      });
    });
  }

  /** Its output, a line at a time, with its name in front. */
  #forward(stream: Readable | null): void {
    if (!stream) return;
    let carry = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (carry + chunk).split("\n");
      carry = (lines.pop() ?? "").slice(-8192);
      for (const line of lines) if (line) this.#log(line.slice(0, 2000));
    });
    stream.on("end", () => {
      if (carry) this.#log(carry.slice(0, 2000));
    });
    stream.on("error", () => {});
  }

  /**
   * While a run is in it, ask the runner every so often whether its event
   * loop is still turning. One that doesn't answer is stuck (a loop that never
   * yields) and is stopped, which fails the runs in it.
   */
  #startHeartbeat(conn: RunnerConnection, child: ChildProcess): void {
    const every = this.opts.heartbeatMs ?? 2000;
    this.#heartbeat = setInterval(() => {
      if (conn.pending === 0 || this.#pinging) return;
      this.#pinging = true;
      void conn.ping(every * 2).then((alive) => {
        this.#pinging = false;
        if (!alive && conn.pending > 0 && this.#child === child) {
          this.#log("stopped answering with a run in it; stopping it");
          child.kill("SIGKILL");
        }
      });
    }, every);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#pinging = false;
  }

  #scheduleIdle(): void {
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => void this.stop(), this.opts.idleMs ?? 10 * 60_000);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}
