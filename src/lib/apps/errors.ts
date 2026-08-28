/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The typed failure vocabulary for app API routes, and the one place a code
 * becomes an HTTP status.
 *
 * This mirrors the two brokers that already do this job — the MCP tool broker
 * (`src/lib/mcp/broker.ts`) and the App Services broker (`src/lib/apps/services.ts`).
 * Both carry a flat string-union of codes plus a single Error subclass, and both
 * predate any notion of HTTP because their callers are a model and another app.
 * The route pipeline is the first caller that has to answer "and what status is
 * that?", so the mapping tables live here rather than being invented at each
 * mount.
 *
 * Two rules this file exists to hold:
 *
 *   1. A handler never chooses a status code for the ordinary cases. It throws
 *      `AppError.notFound(...)` and the pipeline decides. That is what stops
 *      twenty apps from disagreeing about whether a missing record is 404 or 200
 *      with a null body.
 *   2. A message that reaches the client has been through `safeErrorMessage()`.
 *      `AppError` messages are written to be seen, so they are passed through
 *      verbatim; anything *thrown* by a handler is not, and is wrapped.
 */

import { safeErrorMessage } from "@/lib/safe-error";
import type { ServiceErrorCode } from "@/lib/apps/services";

export type AppErrorCode =
  /** No such record, route, or resource. */
  | "NOT_FOUND"
  /** The route exists but does not implement this HTTP method. */
  | "METHOD_NOT_ALLOWED"
  /** The route requires an identity and the caller has none. */
  | "UNAUTHENTICATED"
  /** The caller is known and is not allowed to do this. */
  | "FORBIDDEN"
  /** Request input failed the route's declared `input` schema. */
  | "INVALID_INPUT"
  /** The handler's return value failed the route's declared `output` schema. */
  | "INVALID_OUTPUT"
  /** The request conflicts with current state (duplicate, stale write). */
  | "CONFLICT"
  /** Too many requests. */
  | "RATE_LIMITED"
  /** The route exceeded its declared `budget`. */
  | "BUDGET_EXCEEDED"
  /** The handler did not finish inside its declared `budget.ms`. */
  | "TIMEOUT"
  /** The handler's result was larger than a response may be. */
  | "PAYLOAD_TOO_LARGE"
  /** A dependency the route needs is not configured or is down. */
  | "UNAVAILABLE"
  /** The handler threw something that was not an AppError. */
  | "HANDLER_ERROR";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  // 500, not 400: the caller did nothing wrong. The app returned a shape it
  // promised not to return, and telling the caller "bad request" would send
  // them looking in exactly the wrong place.
  INVALID_OUTPUT: 500,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  // 429 rather than 503: a budget is a quota the caller can back off from and
  // retry against, which is precisely what 429 means to every HTTP client.
  BUDGET_EXCEEDED: 429,
  TIMEOUT: 504,
  PAYLOAD_TOO_LARGE: 500,
  UNAVAILABLE: 503,
  HANDLER_ERROR: 500,
};

/**
 * How an App Services failure surfaces when it escapes a route handler.
 *
 * Without this table every cross-app failure reaches the client as whatever the
 * dispatcher's catch-all produces — today a 404 "Route not found", which sends
 * the reader hunting for a missing file when the real problem was a provider
 * that timed out. A consumer route that lets a `ServiceRequestError` propagate
 * gets an honest status instead.
 */
const STATUS_BY_SERVICE_CODE: Record<ServiceErrorCode, number> = {
  NOT_FOUND: 502,
  NOT_EXPOSED: 502,
  NOT_DECLARED: 502,
  FORBIDDEN: 502,
  NO_USER: 502,
  // The one service failure that is genuinely about *this* caller's user rather
  // than about the wiring between two apps.
  FORBIDDEN_USER: 403,
  NO_HANDLER: 502,
  TIMEOUT: 504,
  PAYLOAD_TOO_LARGE: 502,
  PROVIDER_ERROR: 502,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  /**
   * Extra detail safe to hand back to the caller — Zod issues, the budget that
   * was exceeded. Never an internal message: this is serialized into the
   * response body verbatim.
   */
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  static notFound(message = "Not found", details?: unknown) {
    return new AppError("NOT_FOUND", message, details);
  }
  static unauthenticated(message = "Sign in to continue", details?: unknown) {
    return new AppError("UNAUTHENTICATED", message, details);
  }
  static forbidden(message = "You do not have access to this", details?: unknown) {
    return new AppError("FORBIDDEN", message, details);
  }
  static invalidInput(message = "Invalid request", details?: unknown) {
    return new AppError("INVALID_INPUT", message, details);
  }
  static conflict(message = "That conflicts with the current state", details?: unknown) {
    return new AppError("CONFLICT", message, details);
  }
  static unavailable(message = "That is temporarily unavailable", details?: unknown) {
    return new AppError("UNAVAILABLE", message, details);
  }
  static budgetExceeded(message: string, details?: unknown) {
    return new AppError("BUDGET_EXCEEDED", message, details);
  }
  static timeout(message = "That took too long and was cancelled") {
    return new AppError("TIMEOUT", message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** The HTTP status a code becomes. */
export function statusForAppErrorCode(code: AppErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export function statusForServiceErrorCode(code: ServiceErrorCode): number {
  return STATUS_BY_SERVICE_CODE[code] ?? 502;
}

/** The JSON body shape every failed app route response carries. */
export interface AppErrorBody {
  error: string;
  code: AppErrorCode;
  details?: unknown;
}

/**
 * Normalize anything thrown inside a route into a status and a body.
 *
 * `AppError` messages pass through verbatim — they were written for the caller.
 * Everything else goes through `safeErrorMessage()`, which means a driver error
 * naming a column becomes the generic fallback in production. Note that
 * `safeErrorMessage` never logs, so the caller of this function is responsible
 * for the server-side record.
 */
export function toErrorResponse(
  err: unknown,
  fallback: string,
): { status: number; body: AppErrorBody } {
  if (isAppError(err)) {
    return {
      status: statusForAppErrorCode(err.code),
      body: {
        error: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }

  // A ServiceRequestError escaping a consumer's handler. Duck-typed rather than
  // `instanceof`, because importing the class here would make errors.ts depend
  // on the services broker, which depends on the context builder, which is the
  // cycle both brokers already dodge with dynamic imports.
  if (
    err instanceof Error &&
    err.name === "ServiceRequestError" &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    const code = (err as unknown as { code: ServiceErrorCode }).code;
    return {
      status: statusForServiceErrorCode(code),
      body: {
        error: safeErrorMessage(err, fallback),
        code: code === "FORBIDDEN_USER" ? "FORBIDDEN" : "UNAVAILABLE",
      },
    };
  }

  return {
    status: 500,
    body: { error: safeErrorMessage(err, fallback), code: "HANDLER_ERROR" },
  };
}
