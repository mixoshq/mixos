/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the GitHub App is allowed, what each token asks for, and the manifest
 * that creates the App: the permission decisions in one place.
 *
 * No imports: the page's client components read these too.
 */

/**
 * The App's permissions, exactly: write to contents and pull requests, read
 * checks and commit statuses to show CI, and metadata, which every App has.
 *
 * Not `workflows`, so nothing the App writes can change a workflow file. Not
 * `administration`, so it can't change branch rules, and nothing else. An
 * installation granted anything beyond these is switched off
 * (./installation.ts).
 */
export const APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  checks: "read",
  statuses: "read",
} as const;

export type PermissionLevel = "read" | "write";
export type Permissions = Readonly<Record<string, PermissionLevel>>;

/**
 * The two shapes an operation's token takes, each narrowed to the one linked
 * repository. Write is for a proposal's writes only (./propose.ts), and
 * ./repository.ts limits what it may write; read is for everything that looks.
 */
export const TOKEN_SHAPES = {
  write: { contents: "write", pull_requests: "write" },
  read: { contents: "read", checks: "read", statuses: "read", pull_requests: "read" },
} as const satisfies Record<string, Permissions>;

export type TokenShape = keyof typeof TOKEN_SHAPES;

/**
 * The token that counts the installation's repositories, before any operation.
 * Metadata only, and not narrowed: narrowed, it would see one repository
 * however many the installation covers, and the count is the point.
 */
export const LISTING_PERMISSIONS = { metadata: "read" } as const satisfies Permissions;

/** Where admins create and manage Apps. */
export const GITHUB_WEB_ORIGIN = "https://github.com";

/** Who owns the App: the admin's own account, or an organisation. */
export type AppAccount = { type: "user" } | { type: "organization"; login: string };

/** The manifest GitHub's "create from manifest" page reads. */
export interface AppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  public: false;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: [];
  request_oauth_on_install: false;
}

/** Where GitHub sends the admin back to, under this instance's origin. */
export const CREATED_PATH = "/api/admin/github/created";
export const INSTALLED_PATH = "/api/admin/github/installed";

/**
 * The manifest for this instance's App. Private, the permissions above, no
 * events and an inactive webhook: nothing is ever delivered, and the webhook
 * secret GitHub generates is dropped on arrival. `setup_on_update` sends the
 * admin back here when they change the installation, to check it again.
 *
 * `origin` comes from the environment (`getAppOrigin()`), never a request.
 */
export function appManifest(origin: string, name: string): AppManifest {
  return {
    name,
    url: origin,
    description: `Links one repository to the MixOS instance at ${origin}.`,
    // GitHub wants a URL here even when the hook is off. It is never called.
    hook_attributes: { url: `${origin}/`, active: false },
    redirect_url: `${origin}${CREATED_PATH}`,
    setup_url: `${origin}${INSTALLED_PATH}`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
    request_oauth_on_install: false,
  };
}

/** The default name: "MixOS" and this instance's host, within GitHub's 34 characters. */
export function defaultAppName(origin: string): string {
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    // The page still offers a name to edit.
  }
  return `MixOS ${host}`.trim().slice(0, 34).trim();
}

/** Where the manifest is posted: the admin's own settings or the organisation's. */
export function newAppUrl(account: AppAccount, state: string): string {
  const base =
    account.type === "organization"
      ? `${GITHUB_WEB_ORIGIN}/organizations/${encodeURIComponent(account.login)}/settings/apps/new`
      : `${GITHUB_WEB_ORIGIN}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** The recorded App's owner, as the links below need it. */
export interface AppOwner {
  login: string;
  type: "User" | "Organization";
}

/** The App's settings page, where its keys are generated and it is deleted. */
export function appSettingsUrl(owner: AppOwner, slug: string): string {
  return owner.type === "Organization"
    ? `${GITHUB_WEB_ORIGIN}/organizations/${encodeURIComponent(owner.login)}/settings/apps/${encodeURIComponent(slug)}`
    : `${GITHUB_WEB_ORIGIN}/settings/apps/${encodeURIComponent(slug)}`;
}

/** Where the App is installed on a repository. */
export function installAppUrl(slug: string): string {
  return `${GITHUB_WEB_ORIGIN}/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** An installation's settings, where its repositories are chosen. */
export function installationSettingsUrl(owner: AppOwner, installationId: number): string {
  return owner.type === "Organization"
    ? `${GITHUB_WEB_ORIGIN}/organizations/${encodeURIComponent(owner.login)}/settings/installations/${installationId}`
    : `${GITHUB_WEB_ORIGIN}/settings/installations/${installationId}`;
}

/** A repository's page. */
export function repositoryUrl(owner: string, name: string): string {
  return `${GITHUB_WEB_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** Where a repository's rulesets are added. */
export function rulesetsUrl(owner: string, name: string): string {
  return `${repositoryUrl(owner, name)}/settings/rules`;
}

/**
 * Whether `granted` is within `allowed`: no permission `allowed` lacks, and
 * none at a higher level. Read is within write.
 */
export function permissionsWithin(granted: Readonly<Record<string, string>>, allowed: Permissions): boolean {
  return Object.entries(granted).every(([name, level]) => {
    const limit = allowed[name];
    if (limit === undefined) return false;
    if (level === "read") return true;
    return level === "write" && limit === "write";
  });
}

/**
 * Whether a token's permissions are what was asked for: each asked-for one at
 * that level, and nothing else but the metadata read GitHub adds to every
 * token.
 */
export function tokenPermissionsMatch(granted: Readonly<Record<string, string>>, asked: Permissions): boolean {
  const extra = Object.entries(granted).filter(([name]) => !(name in asked));
  if (extra.some(([name, level]) => !(name === "metadata" && level === "read"))) return false;
  return Object.entries(asked).every(([name, level]) => granted[name] === level);
}
