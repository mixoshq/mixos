/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The HTTP client for GitHub's API: the only module in the GitHub link that
 * sends a request, and it sends them only to https://api.github.com.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 *
 *   - Any other host. The origin is a constant, and a path is accepted only
 *     when it resolves to itself on that origin: absolute, percent-encoded
 *     segments, no `..`, no `//`, no query (that goes in `params`).
 *   - Redirects. Every request is sent with `redirect: "manual"`, and any 3xx
 *     answer is a failure. GitHub answers a renamed repository with a 301 to a
 *     path of its choosing, and following it would build a request from a
 *     response; the link's own check says the repository was renamed instead.
 *   - A slow or large answer: 10 seconds for the whole exchange, body included,
 *     and 4 MB, read with a running count rather than `res.json()`.
 *
 * ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
 *
 * Log. Nothing here writes to the console, and the errors it throws say the
 * method, the path, the status and at most GitHub's own short message: never a
 * header, a token, a JWT or a body. A body that isn't JSON is reported without
 * the parser's message, which quotes the text it choked on.
 *
 * Tokens and JWTs pass through here as the Authorization header and nowhere
 * else. Callers mint them per operation (./installation.ts) and never store,
 * log or return them.
 */

/** The only origin this module talks to. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** GitHub's REST API version, sent with every request. */
const API_VERSION = "2022-11-28";

/** For the whole exchange: every request here runs while an admin waits. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The cap on an answer. GitHub's answers here are small JSON documents. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** GitHub's own error message, cleaned and capped before it reaches an admin. */
const MAX_GITHUB_MESSAGE = 200;

export type GitHubFailure =
  /** No answer: DNS, connection refused, timeout. */
  | "unreachable"
  /** 401: the JWT or the token was refused. */
  | "unauthorized"
  /** 403: not allowed, or rate limited. */
  | "forbidden"
  | "not-found"
  /** Any other status that isn't a success. */
  | "status"
  /** A 3xx, which is never followed. */
  | "redirect"
  /** Not JSON, too large, or not the expected shape. */
  | "malformed"
  /** A path this module refuses to send. */
  | "path";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly failure: GitHubFailure,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Who a request is sent as. */
export type GitHubAuth =
  /** No credentials: the manifest conversion. */
  | { kind: "none" }
  /** The App itself, with a JWT signed by its private key (./jwt.ts). */
  | { kind: "app"; jwt: string }
  /** An installation access token, narrowed to one repository (./installation.ts). */
  | { kind: "installation"; token: string };

export interface GitHubRequest {
  method?: "GET" | "POST" | "DELETE";
  auth: GitHubAuth;
  /** Sent as JSON. */
  body?: unknown;
  /** The query string. */
  params?: URLSearchParams;
  /**
   * How errors name the path, when the path itself holds something that
   * mustn't be repeated: the manifest conversion's one-time code, which can be
   * exchanged for the App's private key within the hour.
   */
  label?: string;
}

export interface GitHubAnswer {
  status: number;
  /** The parsed JSON, or null for an empty answer such as a 204. */
  data: unknown;
}

/**
 * An absolute API path made only of percent-encoded segments. `encodeURIComponent`
 * leaves `!'()*` alone, which are legal in a path, so they are allowed too.
 */
const SAFE_PATH = /^(?:\/[A-Za-z0-9._~%!'()*-]+)+$/;

/**
 * Throws unless `path` is one this module sends: see the module comment.
 *
 * The last check is the one that matters: the URL parser resolves `.` and `..`
 * segments, `%2e` spellings included, so a path that would land anywhere but
 * where it says no longer equals itself once parsed.
 */
export function assertApiPath(path: string): URL {
  const refuse = () => new GitHubError("Refusing to send a request to an unexpected GitHub API path.", "path");
  if (!SAFE_PATH.test(path)) throw refuse();
  if (path.split("/").some((s) => s === "." || s === "..")) throw refuse();
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== path || url.search || url.hash) throw refuse();
  return url;
}

/** One segment of a path, percent-encoded. */
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Send one request to GitHub's API and parse its JSON answer.
 *
 * Throws a GitHubError for anything but a success: see GitHubFailure. A 204
 * is a success with `data: null`.
 */
export async function githubRequest(path: string, request: GitHubRequest): Promise<GitHubAnswer> {
  const method = request.method ?? "GET";
  const url = assertApiPath(path);
  if (request.params) url.search = request.params.toString();

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    // GitHub refuses a request without one.
    "user-agent": "MixOS",
  };
  if (request.auth.kind === "app") headers.authorization = `Bearer ${request.auth.jwt}`;
  if (request.auth.kind === "installation") headers.authorization = `Bearer ${request.auth.token}`;
  if (request.body !== undefined) headers["content-type"] = "application/json";

  const what = `${method} ${request.label ?? path}`;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    throw new GitHubError(`GitHub didn't answer ${what}: ${describeNetworkError(err)}.`, "unreachable");
  }

  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new GitHubError(
      `GitHub answered ${what} with a redirect (${res.status}), which isn't followed.`,
      "redirect",
      res.status,
    );
  }

  const text = await readBounded(res, what);
  if (!res.ok) {
    const said = githubMessage(text);
    const suffix = said ? `: ${said}` : ".";
    const failure: GitHubFailure =
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "forbidden"
          : res.status === 404
            ? "not-found"
            : "status";
    throw new GitHubError(`GitHub answered ${what} with ${res.status}${suffix}`, failure, res.status);
  }

  if (text.trim() === "") return { status: res.status, data: null };
  try {
    return { status: res.status, data: JSON.parse(text) as unknown };
  } catch {
    // Not the parser's message: it quotes the text, which could be anything.
    throw new GitHubError(`GitHub's answer to ${what} wasn't JSON.`, "malformed", res.status);
  }
}

/**
 * The reason a request got no answer, from the error's name and code only.
 * Undici's messages are generic, but a cause can carry the request, so none of
 * it is repeated.
 */
function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "no answer within 10 seconds";
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === "string" && /^[A-Z_]{2,32}$/.test(code)) return code;
  }
  return "the connection failed";
}

/** GitHub's `message` from an error body: printable, one line, capped. */
function githubMessage(text: string): string | null {
  let message: unknown;
  try {
    message = (JSON.parse(text) as { message?: unknown })?.message;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;
  const cleaned = message
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_GITHUB_MESSAGE ? `${cleaned.slice(0, MAX_GITHUB_MESSAGE)}…` : cleaned;
}

/** The body as text, stopping once it passes the cap. */
async function readBounded(res: Response, what: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw new GitHubError(`GitHub stopped answering ${what}: ${describeNetworkError(err)}.`, "unreachable");
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new GitHubError(`GitHub's answer to ${what} was larger than ${MAX_RESPONSE_BYTES} bytes.`, "malformed");
    }
    chunks.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
}
