/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The App's installation as GitHub has it now, and the tokens minted from it.
 *
 * ── THE CHECK BEFORE EVERY OPERATION ────────────────────────────────────────
 *
 * An installation can be changed on GitHub at any time, by anyone who
 * administers the account, and nothing tells this instance. So before every
 * operation the installation is read again, with the App's JWT, and its
 * repositories counted, and the link is switched off when any of these holds
 * (judgeInstallation()):
 *
 *   - it covers every repository on the account (`repository_selection` isn't
 *     `selected`);
 *   - it covers more than one repository, or none;
 *   - its one repository isn't the linked one, by id;
 *   - that repository is upstream MixOS (./identifiers.ts);
 *   - it was granted a permission beyond the App's (./manifest.ts);
 *   - it belongs to an account other than the App's owner.
 *
 * Each is a change that widens what the App's key reaches, so it is refused
 * rather than worked around. Switching off is recorded and audited by the
 * caller (./link.ts).
 *
 * ── TOKENS ──────────────────────────────────────────────────────────────────
 *
 * Minted per operation, from the JWT, and revoked when it ends:
 *
 *   - the listing token: metadata only, over the whole installation, used once,
 *     to count its repositories. Narrowed, it would only ever see one.
 *   - the read and write shapes (./manifest.ts TOKEN_SHAPES), narrowed with
 *     `repository_ids` to the linked repository's id. GitHub's answer is checked:
 *     exactly that repository, exactly those permissions, or the token is
 *     revoked and the operation refused.
 *
 * A token is a local variable of the operation that minted it. It is never
 * stored, logged or returned to a page.
 */

import type { KeyObject } from "node:crypto";
import { GitHubError, githubRequest, segment } from "./api";
import { isUpstream } from "./identifiers";
import { appJwt, parsePrivateKey, PrivateKeyError } from "./jwt";
import {
  APP_PERMISSIONS,
  LISTING_PERMISSIONS,
  TOKEN_SHAPES,
  permissionsWithin,
  tokenPermissionsMatch,
  type Permissions,
  type TokenShape,
} from "./manifest";
import {
  AccessTokenSchema,
  InstallationListSchema,
  InstallationSchema,
  RepositoryListSchema,
  parseAnswer,
  type GitHubRepository,
  type Installation,
} from "./schemas";
import { KeyUnavailableError, readPrivateKeyPem, type AppRecord, type LinkProblem } from "./store";

/** The App's own credentials for one operation. */
export interface AppSession {
  app: AppRecord;
  jwt: string;
}

/** Read and decrypt the stored key, and sign a JWT with it. */
export async function appSession(app: AppRecord): Promise<AppSession> {
  const pem = await readPrivateKeyPem();
  let key: KeyObject;
  try {
    key = parsePrivateKey(pem);
  } catch (err) {
    if (err instanceof PrivateKeyError) throw new KeyUnavailableError("undecryptable");
    throw err;
  }
  return { app, jwt: appJwt(app.id, key) };
}

/** GET /app/installations: every installation of the App. */
export async function listInstallations(session: AppSession): Promise<Installation[]> {
  const { data } = await githubRequest("/app/installations", {
    auth: { kind: "app", jwt: session.jwt },
    params: new URLSearchParams({ per_page: "10" }),
  });
  return parseAnswer(InstallationListSchema, data, "GET /app/installations");
}

/** GET /app/installations/{id}. */
export async function readInstallation(session: AppSession, installationId: number): Promise<Installation> {
  const { data } = await githubRequest(`/app/installations/${segment(installationId)}`, {
    auth: { kind: "app", jwt: session.jwt },
  });
  return parseAnswer(InstallationSchema, data, "GET /app/installations/{id}");
}

/** DELETE /app/installations/{id}: the App uninstalling itself. */
export async function deleteInstallation(session: AppSession, installationId: number): Promise<void> {
  await githubRequest(`/app/installations/${segment(installationId)}`, {
    method: "DELETE",
    auth: { kind: "app", jwt: session.jwt },
  });
}

async function mint(
  session: AppSession,
  installationId: number,
  permissions: Permissions,
  repositoryId: number | null,
): Promise<{ token: string; granted: Record<string, string>; repositories: number[] | null }> {
  const { data } = await githubRequest(`/app/installations/${segment(installationId)}/access_tokens`, {
    method: "POST",
    auth: { kind: "app", jwt: session.jwt },
    body: repositoryId === null ? { permissions } : { repository_ids: [repositoryId], permissions },
  });
  const answer = parseAnswer(AccessTokenSchema, data, "POST /app/installations/{id}/access_tokens");
  return {
    token: answer.token,
    granted: answer.permissions,
    repositories: answer.repositories ? answer.repositories.map((r) => r.id) : null,
  };
}

/** DELETE /installation/token. Best effort: the token expires within the hour regardless. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await githubRequest("/installation/token", { method: "DELETE", auth: { kind: "installation", token } });
  } catch {
    // Nothing to say that wouldn't be noise: it lapses on its own.
  }
}

/**
 * The repositories the installation covers, as many as GitHub counts and the
 * first two of them, through a metadata-only token over the whole
 * installation, revoked straight after.
 */
export async function countRepositories(
  session: AppSession,
  installationId: number,
): Promise<{ total: number; repositories: GitHubRepository[] }> {
  const listing = await mint(session, installationId, LISTING_PERMISSIONS, null);
  try {
    if (!tokenPermissionsMatch(listing.granted, LISTING_PERMISSIONS)) {
      throw new GitHubError("GitHub granted the listing token permissions it wasn't asked for.", "malformed");
    }
    const { data } = await githubRequest("/installation/repositories", {
      auth: { kind: "installation", token: listing.token },
      params: new URLSearchParams({ per_page: "2" }),
    });
    const answer = parseAnswer(RepositoryListSchema, data, "GET /installation/repositories");
    return { total: answer.total_count, repositories: answer.repositories };
  } finally {
    await revokeToken(listing.token);
  }
}

/**
 * A token of `shape`, narrowed to `repositoryId`. Refused, and revoked, unless
 * GitHub's answer covers exactly that repository with exactly those permissions.
 */
export async function mintRepositoryToken(
  session: AppSession,
  installationId: number,
  repositoryId: number,
  shape: TokenShape,
): Promise<string> {
  const asked = TOKEN_SHAPES[shape];
  const minted = await mint(session, installationId, asked, repositoryId);
  const narrowed =
    minted.repositories !== null && minted.repositories.length === 1 && minted.repositories[0] === repositoryId;
  if (!narrowed || !tokenPermissionsMatch(minted.granted, asked)) {
    await revokeToken(minted.token);
    throw new GitHubError(
      narrowed
        ? `GitHub didn't grant the ${shape} token exactly the permissions asked for, so it wasn't used.`
        : `GitHub didn't narrow the ${shape} token to the linked repository, so it wasn't used.`,
      "malformed",
    );
  }
  return minted.token;
}

/** What the checks found. */
export type InstallationVerdict =
  | { ok: true; repository: GitHubRepository }
  | { ok: false; problem: LinkProblem; detail: string };

/**
 * The checks in the module comment, over what GitHub said. `linkedId` is the
 * linked repository's id, or null at link time, when there is none yet.
 *
 * Upstream is judged before "changed", so upstream is what is reported.
 */
export function judgeInstallation(
  app: AppRecord,
  installation: Installation,
  listing: { total: number; repositories: GitHubRepository[] },
  linkedId: number | null,
): InstallationVerdict {
  if (installation.app_id !== app.id || installation.account?.id !== app.owner.id) {
    return {
      ok: false,
      problem: "another-account",
      detail:
        `The installation belongs to ${installation.account?.login ?? "an unknown account"}, ` +
        `not to ${app.owner.login}, which owns the App.`,
    };
  }
  if (installation.repository_selection !== "selected") {
    return {
      ok: false,
      problem: "all-repositories",
      detail: `The installation covers every repository on ${app.owner.login}, not one.`,
    };
  }
  if (!permissionsWithin(installation.permissions, APP_PERMISSIONS)) {
    const extra = Object.entries(installation.permissions)
      .filter(([name, level]) => !permissionsWithin({ [name]: level }, APP_PERMISSIONS))
      .map(([name, level]) => `${name}: ${level}`)
      .sort();
    return {
      ok: false,
      problem: "permissions-widened",
      detail: `The installation was granted more than the App asks for: ${extra.join(", ")}.`,
    };
  }
  if (listing.total > 1 || listing.repositories.length > 1) {
    return {
      ok: false,
      problem: "more-than-one-repository",
      detail: `The installation covers ${Math.max(listing.total, listing.repositories.length)} repositories, not one.`,
    };
  }
  const repository = listing.repositories[0];
  if (listing.total !== 1 || !repository) {
    return { ok: false, problem: "repository-changed", detail: "The installation covers no repository." };
  }
  if (isUpstream(repository.id)) {
    return {
      ok: false,
      problem: "upstream",
      detail: "The installation covers upstream MixOS, mixoshq/mixos. Install the App on your own copy instead.",
    };
  }
  if (linkedId !== null && repository.id !== linkedId) {
    return {
      ok: false,
      problem: "repository-changed",
      detail: `The installation now covers ${repository.owner.login}/${repository.name}, not the linked repository.`,
    };
  }
  return { ok: true, repository };
}
