/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extracts a client-safe error message from an unknown thrown value.
 *
 * In production, internal details (DB column names, stack traces, etc.) are
 * replaced with a generic message. In development, the original message is
 * preserved to aid debugging.
 */
export function safeErrorMessage(
  err: unknown,
  fallback = "An internal error occurred"
): string {
  if (process.env.NODE_ENV === "development") {
    if (err instanceof Error) return err.message;
    return String(err);
  }
  return fallback;
}
