/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Admin > GitHub's actions answer, and what its page is given: the shapes
 * shared by the server (./link.ts) and the page's client components.
 *
 * Nothing secret is ever in one: no token, no JWT, no key. Messages and links
 * are built from stored ids and names, and from GitHub's status codes.
 *
 * No imports: a client component reads this.
 */

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
}
