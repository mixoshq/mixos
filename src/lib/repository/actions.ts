/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * The browse pages' only entry point into the repository.
 *
 * Every export here is a directly-invocable POST endpoint — a server action is
 * reachable by anyone who can guess its id, not only by the page that renders
 * the button. So each one calls `requireAdmin()` itself rather than trusting
 * that the page above it did (docs/security-architecture.md §9).
 *
 * ── ERRORS ARE RETURNED, NOT THROWN ─────────────────────────────────────────
 *
 * A server action that throws reaches the client as an opaque digest in
 * production, which for this feature would turn "the checksum did not match"
 * — the single most important thing this pipeline can say — into "something
 * went wrong". So the outcomes are a discriminated union, and the UI renders
 * the reason. Genuinely unexpected failures still throw and still get the
 * generic treatment.
 */

import { revalidatePath } from "next/cache";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { safeErrorMessage } from "@/lib/safe-error";
import { CheckoutLockHeldError } from "@/lib/platform/checkout-lock";
import { LockUnavailableError } from "@/lib/platform/lock";
import { floorVerdict } from "@/lib/platform/version";
import type { FloorVerdict } from "@/lib/platform/version-floor";
import {
  RepositoryError,
  fetchExtension,
  repositoryBaseUrl,
  searchRepository,
} from "./client";
import { ContentHashMismatch } from "./content-hash";
import { SourceFetchError } from "./fetch-source";
import { ArchiveError } from "./tar";
import {
  InstallError,
  installExtension,
  resolveInstall,
  type InstallResult,
} from "./install";
import { installDisabledMessage, installEnabled } from "./policy";
import {
  KIND_SEGMENT,
  type Extension,
  type ExtensionKind,
  type ExtensionSummary,
  type InstallManifest,
  type SortKey,
} from "./types";

/** Admin, and the identity the audit row is written under. */
async function adminActor() {
  const session = await requireReadOnlySession();
  const user = await requireAdmin(session);
  return { id: user.id, email: user.email };
}

/* -------------------------------------------------------------------------- */
/*  Search                                                                     */
/* -------------------------------------------------------------------------- */

export type SearchOutcome =
  | {
      ok: true;
      items: ExtensionSummary[];
      page: number;
      totalPages: number;
      total: number;
    }
  | {
      ok: false;
      /** Phrased for an admin looking at an empty results panel. */
      message: string;
      /** The repository being talked to, so a misconfiguration is visible. */
      origin: string;
      /** True when the repository simply is not answering — the common case
       *  while mixos.org's public API is still unbuilt. */
      unreachable: boolean;
    };

export async function searchRepositoryAction(input: {
  kind: ExtensionKind;
  q?: string;
  sort?: SortKey;
  page?: number;
}): Promise<SearchOutcome> {
  await adminActor();

  // Every action checks the kind's install flag itself, as it checks admin:
  // with the browse page gone, a direct call is the only way here.
  if (!installEnabled(input.kind)) {
    return {
      ok: false,
      message: installDisabledMessage(input.kind),
      origin: "the repository",
      unreachable: false,
    };
  }

  let origin = "the repository";
  try {
    origin = repositoryBaseUrl();
    const page = await searchRepository({
      kind: input.kind,
      q: input.q?.trim() || undefined,
      sort: input.sort ?? "relevance",
      page: input.page ?? 1,
      pageSize: 24,
    });
    return {
      ok: true,
      items: page.items,
      page: page.page,
      totalPages: page.totalPages,
      total: page.total,
    };
  } catch (err) {
    if (err instanceof RepositoryError) {
      return {
        ok: false,
        message: err.message,
        origin,
        unreachable: err.failure === "unreachable" || err.failure === "config",
      };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Resolve — what exactly am I about to accept?                               */
/* -------------------------------------------------------------------------- */

export type ResolveOutcome =
  | {
      ok: true;
      manifest: InstallManifest;
      listing: Extension | null;
      /** The release's floor against this build: install refuses one that isn't met. */
      floor: FloorVerdict;
    }
  | { ok: false; message: string; code?: string; listing: Extension | null };

/**
 * Read-only. Everything the confirmation dialog needs, in one round trip.
 *
 * Two calls, because the repository splits them: the install manifest carries
 * the version, commit and checksum an admin is being asked to accept, and the
 * full listing carries the GitHub repository the search summary left out.
 *
 * The listing is fetched independently of the manifest and survives the
 * manifest failing. That is deliberate — a release with no usable checksum is
 * exactly the case where an admin most wants to see what they were looking at
 * and where its code lives, and a dialog that renders nothing but an error has
 * thrown that away.
 */
export async function resolveInstallAction(input: {
  kind: ExtensionKind;
  slug: string;
  version?: string;
}): Promise<ResolveOutcome> {
  await adminActor();

  if (!installEnabled(input.kind)) {
    return { ok: false, message: installDisabledMessage(input.kind), code: "disabled", listing: null };
  }

  const listing = await fetchExtension(input.kind, input.slug).catch(() => null);

  try {
    const manifest = await resolveInstall(input.kind, input.slug, input.version);
    return { ok: true, manifest, listing, floor: floorVerdict(manifest.requiresMixOS) };
  } catch (err) {
    if (err instanceof InstallError) {
      return { ok: false, message: err.message, code: err.code, listing };
    }
    if (err instanceof RepositoryError) {
      return { ok: false, message: err.message, code: err.failure, listing };
    }
    return {
      ok: false,
      message: safeErrorMessage(err, "Could not resolve that release."),
      listing,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Install                                                                    */
/* -------------------------------------------------------------------------- */

export type InstallOutcome =
  | { ok: true; result: InstallResult }
  | {
      ok: false;
      /** Stable enough for the UI to change its tone on. */
      code: string;
      message: string;
      /** Generator output or schema errors — rendered as preformatted text. */
      detail?: string;
    };

/**
 * Download, verify, check and install one extension: an app or a connector
 * into `.mixos/pending/`, where it waits for Register, and a theme into
 * `themes/`.
 *
 * Audited either way. A refused install is at least as interesting as a
 * successful one: `<kind>.install.rejected` with `reason: "checksum"` is the
 * row that says someone was served bytes that did not match what the catalogue
 * published, and `reason: "disabled"` is a call that reached a kind this
 * instance does not install — which no page leads to.
 */
export async function installExtensionAction(input: {
  kind: ExtensionKind;
  slug: string;
  version?: string;
  allowYanked?: boolean;
}): Promise<InstallOutcome> {
  const actor = await adminActor();
  const target = `${KIND_SEGMENT[input.kind]}/${input.slug}`;

  try {
    const result = await installExtension(input.kind, input.slug, {
      version: input.version,
      allowYanked: input.allowYanked,
      installedBy: actor.email,
    });

    await recordAdminAction(actor, {
      action: `${input.kind}.install`,
      targetType: input.kind,
      targetId: input.slug,
      details: {
        source: repositoryBaseUrl(),
        version: result.version,
        gitTag: result.gitTag,
        commitSha: result.commitSha,
        // The verified hash, recorded so "which bytes did this instance
        // actually install" is answerable later without re-downloading.
        contentHash: result.contentHash,
        // What Register checks the pending folder against.
        filesHash: result.filesHash,
        installPath: result.installPath,
        pending: result.pending,
        // The check's verdict. What it deferred is listed in the pending
        // install's sidecar; the row says how much there was.
        verdict: "accepted",
        deferred: result.deferred.length,
        // What was written; what install left out is counted by name,
        // `{ ".gitignore": 1 }`, and covered by contentHash, not filesHash.
        fileCount: result.fileCount,
        byteCount: result.byteCount,
        leftOut: result.leftOut,
        // A theme registers as it installs; nothing else has run the
        // generator yet.
        registryValidated: result.registry?.ok ?? null,
        yankedAccepted: input.allowYanked === true,
      },
    });

    // The admin list for this kind is now stale — and for a theme, so is every
    // page, since the active theme is stamped in the root layout.
    revalidatePath(`/admin/${KIND_SEGMENT[input.kind]}`);

    return { ok: true, result };
  } catch (err) {
    const failure = describeFailure(err);

    await recordAdminAction(actor, {
      action: `${input.kind}.install.rejected`,
      targetType: input.kind,
      targetId: input.slug,
      details: {
        source: repositoryBaseUrl(),
        version: input.version ?? "latest",
        reason: failure.code,
        // Never the detail blob: it can carry a generator's absolute paths.
        message: failure.message,
        target,
      },
    });

    return { ok: false, ...failure };
  }
}

/** Map a thrown error onto something the UI can render honestly. */
function describeFailure(err: unknown): { code: string; message: string; detail?: string } {
  // Not a failure of the extension or the repository — someone else is already
  // installing or registering. Its own code so the UI can offer "try again" rather than the
  // tone the rest of this list deserves. Nothing has been downloaded or written.
  if (err instanceof LockUnavailableError) {
    return {
      code: "locked",
      message: "Another administrator is installing or registering. Try again in a moment.",
    };
  }
  // The same, from the checkout lock: another install or registration in this
  // checkout, or a registry generator run, which `npm run dev` and
  // `npm run registry` start. Its message names the holder.
  if (err instanceof CheckoutLockHeldError) {
    return { code: "locked", message: err.message };
  }
  if (err instanceof ContentHashMismatch) {
    return {
      code: "checksum",
      // The heading in the UI already says it failed, so this says what a
      // failure MEANS. Two ways of saying "checksum verification failed" is a
      // sentence the reader skips, and this is the one message on this screen
      // that is worth reading.
      message:
        "The package downloaded from GitHub is not the package the repository " +
        "published a checksum for, so nothing was written to this instance. " +
        "Either the release was changed after it was published, or the download " +
        "was altered in transit. Do not install this until the publisher has " +
        "cut a new release.",
      detail: `expected ${err.expected}\nreceived ${err.actual}`,
    };
  }
  if (err instanceof InstallError) {
    return { code: err.code, message: err.message, detail: err.detail };
  }
  if (err instanceof SourceFetchError) {
    return { code: "download", message: err.message };
  }
  if (err instanceof ArchiveError) {
    return { code: "invalid-package", message: err.message };
  }
  if (err instanceof RepositoryError) {
    return { code: err.failure, message: err.message };
  }
  return {
    code: "unknown",
    message: safeErrorMessage(err, "The install failed."),
  };
}
