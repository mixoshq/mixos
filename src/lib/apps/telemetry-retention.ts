/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How long connector calls are kept in `telemetry_events`:
 * MIXOS_CONNECTOR_TELEMETRY_DAYS, a whole number of days, 90 unless set.
 * The cron tick prunes them (pruneConnectorTelemetry in ./telemetry.ts).
 *
 *   - **0** keeps them all, as every instance did before 28 November 2026.
 *   - **Below 90** counts as 90. Write access an app hasn't used in 90 days
 *     expires (WRITE_EXPIRY_DAYS, ./capability-approvals.ts), and these rows
 *     are how its use is known: fewer days would take away access an app did
 *     use.
 *   - **No upper limit.**
 *   - **Anything that isn't a whole number** deletes nothing until it is
 *     fixed, with a warning, and the release step reports it. Deleting can't
 *     be undone, so a typo such as `365d` must not throw away what whoever
 *     typed it meant to keep.
 *
 * Read per tick and per page, so changing it needs a restart and not a
 * rebuild. Pure, for the release step and the admin page.
 */

export const CONNECTOR_TELEMETRY_DAYS_SETTING = "MIXOS_CONNECTOR_TELEMETRY_DAYS";

/** Days kept when it isn't set. */
export const CONNECTOR_TELEMETRY_DEFAULT_DAYS = 90;

/** The fewest days it keeps: at least WRITE_EXPIRY_DAYS, which a test holds it to. */
export const CONNECTOR_TELEMETRY_MIN_DAYS = 90;

export interface ConnectorTelemetryRetention {
  /** Days kept. Null deletes nothing: 0, or a value that couldn't be read. */
  days: number | null;
  /** Set when the value was raised to the minimum, or couldn't be read. */
  problem: string | null;
}

/** Interpret MIXOS_CONNECTOR_TELEMETRY_DAYS's raw value. */
export function parseConnectorTelemetryDays(raw: string | undefined): ConnectorTelemetryRetention {
  const value = (raw ?? "").trim();
  if (value === "") return { days: CONNECTOR_TELEMETRY_DEFAULT_DAYS, problem: null };
  if (!/^\d+$/.test(value)) {
    return {
      days: null,
      problem:
        `${CONNECTOR_TELEMETRY_DAYS_SETTING}=${JSON.stringify(raw)} is not a whole number of days, so no ` +
        `connector calls are deleted until it is. Use a number of days, ${CONNECTOR_TELEMETRY_MIN_DAYS} or more, ` +
        `or 0 to keep them all.`,
    };
  }
  // A number of any length: one too large for a double is Infinity, which
  // keeps everything, as a number that large would.
  const days = Number(value);
  if (days === 0) return { days: null, problem: null };
  if (days < CONNECTOR_TELEMETRY_MIN_DAYS) {
    return {
      days: CONNECTOR_TELEMETRY_MIN_DAYS,
      problem:
        `${CONNECTOR_TELEMETRY_DAYS_SETTING}=${value} is under ${CONNECTOR_TELEMETRY_MIN_DAYS}, so connector ` +
        `calls are kept for ${CONNECTOR_TELEMETRY_MIN_DAYS} days. Write access an app hasn't used in ` +
        `${CONNECTOR_TELEMETRY_MIN_DAYS} days expires, and these calls are how its use is known.`,
    };
  }
  return { days, problem: null };
}

let warned = false;

/** This instance's connector telemetry retention. Warns once per process about a problem. */
export function connectorTelemetryRetention(): ConnectorTelemetryRetention {
  const retention = parseConnectorTelemetryDays(process.env[CONNECTOR_TELEMETRY_DAYS_SETTING]);
  if (retention.problem && !warned) {
    warned = true;
    console.warn(`[telemetry] ${retention.problem}`);
  }
  return retention;
}

/** What is wrong with MIXOS_CONNECTOR_TELEMETRY_DAYS, for the release step and the admin page, or null. */
export function connectorTelemetryProblem(): string | null {
  return parseConnectorTelemetryDays(process.env[CONNECTOR_TELEMETRY_DAYS_SETTING]).problem;
}

/** The oldest a kept row may be, or null when nothing is deleted. */
export function connectorTelemetryCutoff(days: number | null, now: number = Date.now()): Date | null {
  if (days === null) return null;
  const cutoff = now - days * 86_400_000;
  // Before 1970, or not a number at all: nothing recorded is that old.
  if (!(cutoff > 0)) return null;
  return new Date(cutoff);
}
