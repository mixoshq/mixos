/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Remove button's actions answer (./remove-actions.ts), as the admin
 * pages read it, and the sentences the dialog, the commit and `npm run remove`
 * share about what stays.
 *
 * Types and text, and no imports a browser can't load: the dialog uses this
 * module, and ./remove-admin.ts, which does the work, reads the filesystem and
 * the database.
 */

import type { RemovalHandBack } from "./hand-back";
import type { Refusal } from "./pending-outcomes";
import type { RemovalNote } from "./remove";
import type { ExtensionKind } from "./types";

/** Where an extension was installed from, as a person reads it: `mixos.org` and `1.2.0`. */
export interface InstalledFrom {
  host: string;
  version: string;
}

/** What removing an extension would do, and what stands in its way. Chosen field by field. */
export interface RemovalPreview {
  kind: ExtensionKind;
  slug: string;
  /** The manifest's name, or the slug. */
  name: string;
  /** Repo-relative: `apps/<slug>`. */
  path: string;
  /** From its install record, or null for a local one. */
  installed: InstalledFrom | null;
  /** What stops it being removed. Remove is offered only when there is none. */
  blockers: RemovalNote[];
  /** What to know before removing it. */
  warnings: RemovalNote[];
  /** A pending install of the same name, repo-relative, which removing discards. */
  pending: string | null;
  /** The same, in a terminal in this checkout. */
  command: string;
}

export type PreviewOutcome = { ok: true; preview: RemovalPreview } | Refusal;

/** What the removal result shows. Chosen field by field: nothing else reaches the browser. */
export interface Removed {
  kind: ExtensionKind;
  slug: string;
  name: string;
  /** Repo-relative: `apps/<slug>`. */
  path: string;
  installed: InstalledFrom | null;
  warnings: RemovalNote[];
  /** The pending install of the same name it discarded, repo-relative, or null. */
  discardedPending: string | null;
  /** Whether this server stops serving it without a rebuild: `next dev`. */
  servesNow: boolean;
  /** What to commit, and how. */
  handBack: RemovalHandBack;
}

export type RemoveOutcome = { ok: true; result: Removed } | Refusal;

/** What stays in each database, said before removing it. */
export const KEPT_BEFORE: Record<ExtensionKind, string> = {
  app:
    "Its data stays in this checkout's database and in every other that has it: its tables, " +
    "settings, API keys, grants and scheduled jobs.",
  connector:
    "Its credentials, and its users' connections, stay in this checkout's database and in every " +
    "other that has them.",
  theme: "A theme holds no data.",
};

/** What each instance keeps once the removal is deployed: for the commit, the result and the CLI. */
export const KEPT_DATA: Record<ExtensionKind, string> = {
  app: "Each instance keeps the app's data until an admin deletes it there.",
  connector: "Each instance keeps the connector's credentials until an admin deletes them there.",
  theme: "A theme holds no data.",
};
