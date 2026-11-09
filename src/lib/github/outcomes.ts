/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Deployment > GitHub App's actions answer, and what its page is given: the shapes
 * shared by the server (./link.ts, ./propose.ts, ./proposals.ts) and the
 * pages' client components.
 *
 * Nothing secret is ever in one: no token, no JWT, no key. Messages and links
 * are built from stored ids and names, and from GitHub's status codes.
 *
 * Type imports only: a client component reads this.
 */

import type { FloorVerdict } from "@/lib/platform/version-floor";
import type { RemovalNote } from "@/lib/repository/remove";
import type { ExtensionKind } from "@/lib/repository/types";
import type { FolderDifferences } from "@/lib/repository/update";
import type { ComparisonFacts, PickableRelease, ReleaseView } from "@/lib/repository/update-outcomes";
import type { ProposalAction } from "./names";

export type OutcomeTone = "success" | "info" | "neutral" | "warning" | "danger";

export interface OutcomeLink {
  label: string;
  href: string;
}

export type GitHubOutcome =
  | { ok: true; message: string; links?: OutcomeLink[] }
  | { ok: false; code: string; message: string; tone: OutcomeTone; links?: OutcomeLink[] };

/** "Create on GitHub": where to post the manifest, and the manifest. */
export type StartOutcome =
  | { ok: true; action: string; manifest: string }
  | Extract<GitHubOutcome, { ok: false }>;

/** Where the "create the App" round trip ended, as `?created=` on the page. */
export const CREATED_OUTCOMES = [
  "created",
  "off",
  "state",
  "exists",
  "busy",
  "conversion-failed",
  "permissions",
  "error",
] as const;
export type CreatedOutcome = (typeof CREATED_OUTCOMES)[number];

/** What the page shows about the link, read on the server. */
export interface GitHubPageState {
  /** GITHUB_APP_ENCRYPTION_KEY: unset, not 32 bytes, or usable. */
  feature: "off" | "malformed" | "on";
  /** A stored record that can't be read. Only Unlink is offered. */
  corrupt: boolean;
  /** This instance's public URL, or null when it can't be worked out. */
  origin: string | null;
  defaultName: string;
  app: {
    id: number;
    slug: string;
    name: string;
    owner: string;
    ownerType: "User" | "Organization";
    keyFingerprint: string;
    /** Whether the stored key decrypts and parses under the current encryption key. */
    keyReadable: boolean;
    settingsUrl: string;
    installUrl: string;
  } | null;
  link: {
    installationId: number;
    installationUrl: string;
    repository: {
      id: number;
      fullName: string;
      url: string;
      defaultBranch: string;
      private: boolean;
      fork: boolean;
      parent: string | null;
    };
    linkedAt: string;
    checkedAt: string | null;
    disabled: { at: string; reason: string; detail: string } | null;
    rulesetsUrl: string;
  } | null;
  branchRule: {
    branch: string;
    checkedAt: string;
    pullRequest: boolean;
    rules: string[];
    /** GitHub's status when it wouldn't show the rules. */
    unreadStatus: number | null;
  } | null;
  override: { reason: "classic-protection" | "free-private"; at: string; by: string } | null;
  /** The admin's confirmation that nothing else builds the App's branches, for the linked repository. */
  previewChecklist: { at: string; by: string } | null;
}

/* -------------------------------------------------------------------------- */
/*  Proposals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One thing that has to hold before a proposal, as the propose dialog lists
 * it. The last four are a MixOS update's own (./update-pull.ts).
 */
export interface ProposalCheckLine {
  id: "rule" | "checklist" | "workflows" | "render" | "vercel" | "folder" | "branch" | "tag" | "main" | "changes";
  ok: boolean;
  label: string;
  detail: string;
  /** What a file check found, file by file. */
  findings?: ProposalFinding[];
  /** The refusal's code when the line doesn't hold and it isn't the line's id: `folder-mismatch`. */
  code?: string;
}

export interface ProposalFinding {
  file: string;
  problem: string;
}

/** What the propose dialog shows before anything is downloaded or written. */
export interface ProposalPreview {
  ok: true;
  /** `owner/name`. */
  repository: string;
  repositoryUrl: string;
  defaultBranch: string;
  release: {
    version: string;
    gitTag: string | null;
    commitSha: string;
    contentHash: string;
    subpath: string | null;
    yanked: boolean;
    /** The publisher's words, flattened to one line. */
    yankedReason: string | null;
  };
  /** Where the code lives, from the listing. */
  source: { owner: string; name: string; url: string } | null;
  floor: FloorVerdict;
  names: { branch: string; title: string; folder: string };
  lines: ProposalCheckLine[];
  /** Every line holds. */
  ready: boolean;
  /** What the publisher says it needs: their claims, never checked. */
  permissions: { scope: string; reason: string }[];
}

export type ProposalCheckOutcome = ProposalPreview | Extract<GitHubOutcome, { ok: false }>;

export type ProposeOutcome =
  | {
      ok: true;
      message: string;
      links: OutcomeLink[];
      pullRequest: { number: number; url: string; branch: string; head: string };
    }
  | (Extract<GitHubOutcome, { ok: false }> & { findings?: ProposalFinding[] });

/**
 * Whether Browse offers "Propose to <owner>/<repo>", read from what is stored:
 * null on a checkout, or with nothing linked. `off` says why it is offered but
 * can't be used yet. The notices, the Browse cards of installed extensions
 * and the Remove dialog offer "Propose update" and "Propose removal" on the
 * same answer.
 */
export interface ProposalTarget {
  repository: string;
  off: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Updates and removals                                                        */
/* -------------------------------------------------------------------------- */

/** What the App does to an extension already in the build. */
export type ChangeAction = "update" | "remove";

/**
 * What the propose dialog shows for an update or a removal when it opens:
 * what this build runs and what the default branch holds of it, the releases
 * to pick from, what depends on it, the names, and the checks. Nothing is
 * downloaded for it.
 */
export interface ChangeProposalPreview {
  ok: true;
  action: ChangeAction;
  /** `owner/name`. */
  repository: string;
  repositoryUrl: string;
  defaultBranch: string;
  kind: ExtensionKind;
  slug: string;
  /** The manifest's name as this build has it, or the slug. */
  name: string;
  /** `apps/files`. */
  folder: string;
  /** The catalogue's host, as people say it: `mixos.org`. */
  host: string;
  /** The release this build runs, from its install record, with what the listing says of it. */
  installed: ReleaseView & {
    /** Null when the listing no longer has it, or couldn't be read. */
    yanked: boolean | null;
    yankedReason: string | null;
  };
  /** The folder on the default branch: how many files it holds. Null when it isn't there. */
  onBranch: { files: number } | null;
  /** For an update: the releases on the catalogue, newest first. Empty for a removal, or when the listing couldn't be read. */
  releases: PickableRelease[];
  listingProblem: string | null;
  /** The release the picker starts on: the catalogue's current one when it is something to do. */
  suggested: string | null;
  /** For a removal: what stops it, and what to know first. Null for an update. */
  removal: { blockers: RemovalNote[]; warnings: RemovalNote[] } | null;
  /** The branch, and a removal's title. An update's title names the release picked. */
  names: { branch: string; title: string | null };
  lines: ProposalCheckLine[];
  /** Every line holds, and for a removal nothing depends on it. */
  ready: boolean;
}

export type ChangeProposalCheckOutcome = ChangeProposalPreview | Extract<GitHubOutcome, { ok: false }>;

/**
 * Everything the dialog says about updating the folder on the default branch
 * to one release, both downloaded and verified in memory to say it: the
 * update dialog's comparison, plus the files the tree changes and the names.
 */
export interface UpdateProposalComparison extends ComparisonFacts {
  ok: true;
  /** What the tree changes in the folder, file by file. */
  files: FolderDifferences;
  names: { branch: string; title: string };
}

export type UpdateProposalCompareOutcome = UpdateProposalComparison | Extract<GitHubOutcome, { ok: false }>;

/** What a listed pull request proposes: an extension of a kind, or an update of MixOS itself. */
export type ProposalKind = "app" | "connector" | "theme" | "mixos";

/** An open pull request the App opened, as the Apps page and Deployment > GitHub App list it. */
export interface ProposedPullRequest {
  number: number;
  url: string;
  kind: ProposalKind;
  /** The extension's slug, or for a MixOS update the release's tag. */
  slug: string;
  branch: string;
  /** What it proposes, from its branch's name. */
  action: ProposalAction;
  /** From the `<kind>.propose` audit row, when there is one: the release added or updated to, or the one removed. */
  version: string | null;
  proposedAt: string | null;
  proposedBy: string | null;
  /** True when the instance has no `<kind>.propose` row for it. */
  unrecorded: boolean;
  /** True when its head isn't the commit the App made. */
  changed: boolean;
  ci: {
    state: "passed" | "failed" | "running" | "waiting" | "none";
    label: string;
    tone: "success" | "warning" | "danger" | "neutral";
    detail: string;
  };
}

export type ProposalsView =
  /** The App is off or nothing is linked: nothing to show. */
  | { state: "off" }
  | { state: "unavailable"; message: string }
  | {
      state: "ok";
      repository: string;
      repositoryUrl: string;
      pulls: ProposedPullRequest[];
      /** Open App pull requests of this kind not listed. */
      more: number;
    };

/* -------------------------------------------------------------------------- */
/*  MixOS updates                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the release notice offers under a newer release, from what this
 * instance stores alone (./update-pull.ts mixosUpdateOffer()): never a request
 * to GitHub, since the notice is on every admin page. Null, and the notice
 * stays as it was, when the App is off, nothing is linked, the link is off,
 * or this is a checkout.
 */
export type UpdateOffer =
  /** A fork of upstream, with no pull request recorded for this release: the button. */
  | {
      kind: "fork";
      tag: string;
      commitSha: string;
      /** `owner/name`. */
      repository: string;
      defaultBranch: string;
      branch: string;
      title: string;
      /** Why the button is off for now (the rule, the checklist), as Browse says it, or null. */
      off: string | null;
      /** What changed between this build and the release, on GitHub; null when this build's commit isn't known. */
      compareUrl: string | null;
    }
  /** Not a fork of upstream: no button. The merge by hand, and what changed. */
  | { kind: "copy"; tag: string; repository: string; compareUrl: string | null; command: string }
  /** This instance opened a pull request for this release: say so, and nothing else. */
  | { kind: "proposed"; tag: string; repository: string; number: number; url: string; at: string; by: string };

/** GitHub's numbers for the release against the default branch, from its compare answer. */
export interface UpdateCompare {
  ahead: number;
  behind: number;
  commits: number;
  files: number;
}

export type UpdateOutcome =
  | {
      ok: true;
      message: string;
      links: OutcomeLink[];
      pullRequest: { number: number; url: string; branch: string; head: string };
      compare: UpdateCompare;
    }
  | Extract<ProposeOutcome, { ok: false }>;
