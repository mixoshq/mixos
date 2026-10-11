/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the review, Register, Discard and "Activate in this checkout" actions
 * answer (./pending-actions.ts), as the admin pages read it.
 *
 * Types and one formatter, and no imports a browser can't load: the client
 * components use this module, and ./pending-admin.ts, which does the work,
 * reads the filesystem and the database.
 */

import type { DatabaseLocation } from "../db/locality";
import type { PendingKind } from "./pending";
import type { PendingReview } from "./review";

/**
 * How a refusal reads. `info` is the design (a built deployment); `neutral`
 * is nothing to fix (a lock someone else holds, so try again); `warning` is
 * something to act on; `danger` is something nobody expected.
 */
export type NoticeTone = "info" | "neutral" | "warning" | "danger";

export interface Refusal {
  ok: false;
  /** Stable, for the page to branch on: `locked` offers Try again. */
  code: string;
  message: string;
  /** The registry generator's output, or the hashes that disagreed. */
  detail?: string;
  tone: NoticeTone;
}

/** What the catalogue says about a pending install: the publisher's claims, and where its source is. */
export type ListingFacts =
  | {
      state: "ok";
      /** The catalogue asked. */
      origin: string;
      /** The publisher's claims for the installed version. Null when they couldn't be read. */
      claims: { scope: string; reason: string }[] | null;
      /** The source on GitHub at the commit install verified. */
      sourceUrl: string | null;
      /** Anything about the answer the admin should know. */
      note: string | null;
    }
  | { state: "unavailable"; origin: string; message: string };

export type ReviewOutcome = { ok: true; review: PendingReview; listing: ListingFacts } | Refusal;

/**
 * Who may turn the app on after Register, and where:
 *
 *   - `here`: this checkout's database is local and this server runs what was
 *     registered now (`next dev`), so "Activate in this checkout" is offered;
 *   - `after-rebuild`: local, but this server is a production build of the
 *     checkout from before Register, which serves the app once rebuilt;
 *   - `elsewhere`: the database may be shared, so the app is activated in
 *     Admin > Apps on the instance that serves it;
 *   - `none`: a connector, which has no switch to turn on.
 */
export type Activation = "here" | "after-rebuild" | "elsewhere" | "none";

/** What the Register result shows. Chosen field by field: nothing else reaches the browser. */
export interface Registered {
  kind: PendingKind;
  slug: string;
  version: string;
  gitTag: string | null;
  commitSha: string;
  /** Repo-relative: `apps/<slug>`. */
  installPath: string;
  fileCount: number;
  byteCount: number;
  /** What install's check left to registration, which this run checked. */
  deferredChecked: number;
  /** An app's `migrations/*.sql`, which `npm run migrate:apps` applies here. */
  migrations: number;
  /** Whether this server runs what was registered without a rebuild. */
  servesNow: boolean;
  database: DatabaseLocation;
  activation: Activation;
}

export type RegisterOutcome = { ok: true; result: Registered } | Refusal;
export type DiscardOutcome = { ok: true; pendingPath: string } | Refusal;
export type ActivateOutcome = { ok: true; slug: string } | Refusal;

/** The database's hosts, as a phrase. */
export function describeHosts(database: DatabaseLocation): string {
  return database.hosts.length > 0 ? database.hosts.join(", ") : "a host this server can't name";
}
