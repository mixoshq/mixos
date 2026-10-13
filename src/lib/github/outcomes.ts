/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Admin > GitHub's actions answer, and what its page is given: the shapes
 * shared by the server (./link.ts, ./propose.ts, ./proposals.ts) and the
 * pages' client components.
 *
 * Nothing secret is ever in one: no token, no JWT, no key. Messages and links
 * are built from stored ids and names, and from GitHub's status codes.
 *
 * Type imports only: a client component reads this.
 */

import type { FloorVerdict } from "@/lib/platform/version-floor";

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

/** One thing that has to hold before a proposal, as the propose dialog lists it. */
export interface ProposalCheckLine {
  id: "rule" | "checklist" | "workflows" | "render" | "vercel" | "folder" | "branch";
  ok: boolean;
  label: string;
  detail: string;
  /** What a file check found, file by file. */
  findings?: ProposalFinding[];
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
 * can't be used yet.
 */
export interface ProposalTarget {
  repository: string;
  off: string | null;
}

/** An open pull request the App opened, as the Apps page lists it. */
export interface ProposedPullRequest {
  number: number;
  url: string;
  kind: "app" | "connector" | "theme";
  slug: string;
  branch: string;
  /** From the `<kind>.propose` audit row, when there is one. */
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
