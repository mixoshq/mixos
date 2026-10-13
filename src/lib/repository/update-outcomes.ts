/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the update dialog's actions answer (./update-actions.ts), as the dialog
 * reads it: the overview of an extension that can be updated, the comparison
 * with the release the admin picked, and the update.
 *
 * Types only, and no imports a browser can't load: the dialog uses this
 * module, and ./update-admin.ts, which does the work, reads the checkout and
 * asks the catalogue and GitHub. Every field is chosen; nothing else reaches
 * the browser.
 */

import type { FloorVerdict } from "../platform/version-floor";
import type { HandBack } from "./hand-back";
import type { ReviewedUpdate } from "./install";
import type { UpdateDirection } from "./pending";
import type { Refusal } from "./pending-outcomes";
import type { ExtensionKind } from "./types";
import type { ClaimChanges, DeclarationChange, LocalChanges, MigrationChanges } from "./update";

/** A release, as the dialog names it. */
export interface ReleaseView {
  version: string;
  gitTag: string | null;
  commitSha: string;
  /** When the catalogue says it was published, as an ISO date, or null when it doesn't say. */
  releasedAt: string | null;
  /** Its source on GitHub at that commit, or null. */
  sourceUrl: string | null;
}

/** One release the admin can pick, newest first. */
export interface PickableRelease {
  version: string;
  gitTag: string | null;
  commitSha: string;
  releasedAt: string | null;
  /** Withdrawn by its publisher. */
  yanked: boolean;
  /** The catalogue's current release. */
  current: boolean;
  /** Which way it is from the installed release: `same` is the installed release itself. */
  direction: UpdateDirection;
}

/** What the dialog shows first: what is installed, what changed in it, and what it can update to. */
export interface UpdateOverview {
  kind: ExtensionKind;
  slug: string;
  /** The manifest's name, or the slug. */
  name: string;
  /** Repo-relative: `apps/<slug>`. */
  path: string;
  /** The catalogue it was installed from, as people say it: `mixos.org`. */
  host: string;
  /** The installed release, from the folder's install record, with what the listing says of it. */
  installed: ReleaseView & {
    /** Null when the listing no longer has it. */
    yanked: boolean | null;
    yankedReason: string | null;
  };
  /** Whether the folder still matches its install record, and the files that differ when it doesn't. */
  local: LocalChanges;
  /** The releases on the catalogue, newest first. Empty when the listing couldn't be read. */
  releases: PickableRelease[];
  /** Why the listing couldn't be read, when it couldn't. */
  listingProblem: string | null;
  /** The release the picker starts on: the catalogue's current one when it is something to do. */
  suggested: string | null;
}

export type OverviewOutcome = { ok: true; overview: UpdateOverview } | Refusal;

/** Everything the dialog says about updating to one release, downloaded and verified to say it. */
export interface UpdateComparison {
  kind: ExtensionKind;
  slug: string;
  name: string;
  path: string;
  host: string;
  from: ReleaseView;
  to: ReleaseView & {
    contentHash: string;
    yanked: boolean;
    /** The publisher's reason, as plain text. */
    yankedReason: string | null;
  };
  direction: UpdateDirection;
  /** GitHub's view of what changed between the two commits, older first. Null across repositories. */
  compareUrl: string | null;
  /** The release comes from another GitHub repository than the installed one: both, as `owner/name`. */
  otherRepository: { from: string; to: string } | null;
  /** The release's `requiresMixOS` against this checkout. */
  floor: FloorVerdict;
  /** The publisher's claims on the catalogue, from release to release. */
  claims: ({ state: "ok" } & ClaimChanges) | { state: "unavailable"; message: string };
  /**
   * What the package's manifest declares, the rows that change. Null when
   * either manifest can't be read; empty for a theme, which runs no code.
   */
  declarations: DeclarationChange[] | null;
  /** An app's migrations, from the folder to the release. Empty for a connector. */
  migrations: MigrationChanges;
  /** Whether the folder no longer matches its install record. */
  localChanges: boolean;
  /** What the admin has to choose before the update is made. */
  needs: { discardLocalChanges: boolean; allowOlder: boolean; allowYanked: boolean };
  /** What stops the update outright, or null. A floor that isn't met is in `floor`. */
  blocker: string | null;
  /** Sent back with the update, which is refused if any of it has changed since. */
  reviewed: ReviewedUpdate;
}

export type ComparisonOutcome = { ok: true; comparison: UpdateComparison } | Refusal;

/**
 * What the update made: for an app or a connector, the release waiting in
 * pending for Register, and what it replaces; for a theme, which registers as
 * it installs, the release in place, and what to commit.
 */
export interface PreparedUpdate {
  kind: ExtensionKind;
  slug: string;
  name: string;
  /** Repo-relative: `apps/<slug>`, unchanged until Register; `themes/<slug>`, updated. */
  path: string;
  /** Repo-relative: `.mixos/pending/apps/<slug>`, where the release waits. Null for a theme, which doesn't. */
  pendingPath: string | null;
  from: { version: string; gitTag: string | null };
  to: { version: string; gitTag: string | null; commitSha: string };
  direction: UpdateDirection;
  localChangesDiscarded: boolean;
  /** For a theme: what to commit, and how to roll it back. Null while a release waits for Register. */
  handBack: HandBack | null;
  /** What to do next, in a paragraph. */
  nextStep: string;
}

export type UpdateOutcome = { ok: true; result: PreparedUpdate } | Refusal;
