/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A note's date, as the menu bar and the Release Notes page print it.
 *
 * One locale and UTC, the zone the dates are in: the page renders on the
 * server and again in the browser, and two locales would print two dates and
 * fail hydration.
 */

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const SHORT_WITH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const LONG = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

function at(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** "Oct 25", with the year when it isn't `today`'s: "Oct 25, 2025". */
export function formatShortNoteDate(date: string, today: Date = new Date()): string {
  const day = at(date);
  return (day.getUTCFullYear() === today.getUTCFullYear() ? SHORT : SHORT_WITH_YEAR).format(day);
}

/** "October 25, 2026", for a day's heading. */
export function formatNoteDay(date: string): string {
  return LONG.format(at(date));
}
