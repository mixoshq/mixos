/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The update dialog's work: what updating an extension to another release would
 * do, and making the update. Behind the server actions in
 * ./update-actions.ts, which pass in the signed-in admin and the facts about
 * this deployment, so a test can pass its own.
 *
 * Each one, in this order:
 *
 *   1. Requires an admin (`admin()`, which is requireAdmin()), before it reads
 *      anything else. A server action is reachable by anyone who can name it,
 *      not only by the page that shows the button (docs/security-architecture.md §9).
 *   2. Refuses on a built deployment, which has no checkout to change, as
 *      information; and a checkout that can't install the kind
 *      (checkInstallable() in ./install.ts).
 *   3. The overview and the comparison read the checkout and ask the catalogue
 *      and GitHub. They take no lock and write nothing. The update is install's
 *      update mode (./install.ts), under both locks, which checks everything
 *      again, and is audited here, as an install is in ./actions.ts:
 *      `<kind>.update`, or `<kind>.update.rejected` with the reason.
 *   4. Returns what happened as a value, since a thrown error reaches the
 *      browser as an opaque digest in production.
 *
 * ── WHAT IS DOWNLOADED TO SHOW IT ───────────────────────────────────────────
 *
 * The overview downloads the installed release only when the folder no longer
 * matches its install record, and only to name the files that changed. The
 * comparison downloads the release the admin picked, to read what its manifest
 * declares and which migrations it carries. Each is pinned to its commit and
 * checked against its content hash, as install checks a release, and read in
 * memory: nothing is written, and none of it runs.
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "../apps/admin-audit";
import { BUILT_DEPLOYMENT_UPDATE_NOTICE } from "../platform/build";
import { floorVerdict } from "../platform/version";
import { RepositoryError, fetchExtension, fetchInstallManifest } from "./client";
import { ContentHashMismatch, verifyContentHash } from "./content-hash";
import { fetchExtensionTree } from "./fetch-source";
import {
  checkInstallable,
  checkoutRoot,
  describeInstallFailure,
  fetchRecordedRelease,
  installExtension,
  installedForUpdate,
  leaveOut,
  preflight,
  publishedDates,
  recordedOrigin,
  resolveInstall,
  type InstalledExtension,
} from "./install";
import { githubCompareUrl, githubSourceUrl, isRecordedVersion, recordSourceUrl } from "./install-record";
import type { NoticeTone, Refusal } from "./pending-outcomes";
import { sourceHost } from "./provenance";
import { manifestName, readManifest, shownText } from "./review";
import {
  compareClaims,
  compareDeclarations,
  compareMigrations,
  folderMigrations,
  folderState,
  localChangesBetween,
  needsOlderConsent,
  releaseManifest,
  releaseMigrations,
  sameRepository,
  shownClaims,
  unhashableProblem,
  updateDirection,
  type LocalChanges,
  type ReleaseRef,
} from "./update";
import type {
  ComparisonOutcome,
  OverviewOutcome,
  PickableRelease,
  UpdateComparison,
  UpdateOutcome,
  UpdateOverview,
} from "./update-outcomes";
import { cleanReason } from "./updates";
import {
  CONTENT_HASH_PATTERN,
  CommitShaSchema,
  ExtensionKindSchema,
  KIND_SEGMENT,
  SlugSchema,
  type Extension,
  type ExtensionKind,
  type InstallManifest,
} from "./types";

export interface UpdateContext {
  /** The signed-in admin, or a throw: requireAdmin(). Called first. */
  admin(): Promise<AdminActor>;
  /** isBuiltDeployment(). */
  builtDeployment(): boolean;
  /** revalidatePath(). */
  revalidate(path: string): void;
}

/* -------------------------------------------------------------------------- */
/*  Shared                                                                      */
/* -------------------------------------------------------------------------- */

const TargetSchema = z.object({ kind: ExtensionKindSchema, slug: SlugSchema });

const VersionSchema = z.string().max(128).refine(isRecordedVersion);

const CompareInputSchema = TargetSchema.extend({ version: VersionSchema });

const HashSchema = z.string().regex(CONTENT_HASH_PATTERN);

const UpdateInputSchema = CompareInputSchema.extend({
  allowYanked: z.boolean().optional(),
  allowOlder: z.boolean().optional(),
  discardLocalChanges: z.boolean().optional(),
  /** What the admin reviewed: the update is refused if any of it has changed since. */
  reviewed: z.object({
    installedCommit: CommitShaSchema,
    installedFilesHash: HashSchema,
    folderHash: HashSchema.nullable(),
    targetCommit: CommitShaSchema,
    targetContentHash: HashSchema,
  }),
});

const notUpdatable = (): Refusal => ({
  ok: false,
  code: "not-updatable",
  message: "That isn't a release of an extension in this checkout.",
  tone: "warning",
});

const builtDeployment = (): Refusal => ({
  ok: false,
  code: "unsupported-environment",
  message: BUILT_DEPLOYMENT_UPDATE_NOTICE,
  tone: "info",
});

/** How a refusal reads: a lock is a wait, the design is information, a bad download is a fault. */
function toneOf(code: string): NoticeTone {
  if (code === "locked") return "neutral";
  if (code === "unsupported-environment" || code === "disabled") return "info";
  if (code === "checksum" || code === "unknown") return "danger";
  return "warning";
}

/** Any failure of the overview, the comparison or the update, as the dialog says it. */
export function updateRefusal(err: unknown): Refusal {
  const failure = describeInstallFailure(err);
  // Its words can name this machine's paths; the log keeps them.
  if (failure.code === "unknown") console.error("[update] unexpected failure:", err);
  return { ok: false, code: failure.code, message: failure.message, detail: failure.detail, tone: toneOf(failure.code) };
}

/** Whether this checkout can install the kind at all: checkInstallable(), as a refusal. */
async function notInstallable(kind: ExtensionKind): Promise<Refusal | null> {
  const installable = await checkInstallable(kind);
  if (installable.ok) return null;
  const code = installable.code ?? "unsupported-environment";
  return { ok: false, code, message: installable.reason ?? "This checkout can't install it.", tone: toneOf(code) };
}

/** An ISO date from the catalogue's text, or null. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}


/* -------------------------------------------------------------------------- */
/*  The overview                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the dialog shows first: the installed release, whether the folder still
 * matches it and which files don't, and the releases on the catalogue, each
 * with which way it is from the installed one. Reads the checkout at `root`
 * and asks the catalogue; downloads the installed release only to name changed
 * files. Throws as install does (InstallError, RepositoryError).
 */
export async function updateOverview(kind: ExtensionKind, slug: string, root: string = checkoutRoot()): Promise<UpdateOverview> {
  const installed = installedForUpdate(kind, slug, root);
  const { record } = installed;
  const host = sourceHost(record.source);
  const name = manifestName(readManifest(installed.dir, installed.kind), installed.kind, slug);
  const state = folderState(installed.dir, record);
  const local: LocalChanges = state.modified ? await listLocalChanges(installed) : { state: "none" };

  let listing: Extension | null = null;
  let listingProblem: string | null = null;
  try {
    listing = await fetchExtension(kind, slug);
  } catch (err) {
    listingProblem =
      err instanceof RepositoryError && err.failure === "not-found"
        ? `${host} no longer lists ${name}, so there is no other release to update to.`
        : `${host} couldn't be asked which releases ${name} has: ${err instanceof Error ? err.message : String(err)}`;
  }

  const listed = listing?.releases.find((r) => r.commitSha === record.commitSha) ?? null;
  const from: ReleaseRef = { version: record.version, commitSha: record.commitSha, releasedAt: isoOrNull(listed?.releasedAt) };
  const releases = listing ? pickable(listing, from) : [];
  const current = releases.find((r) => r.current);

  return {
    kind: installed.kind,
    slug,
    name,
    path: installed.rel,
    host,
    installed: {
      version: record.version,
      gitTag: record.gitTag,
      commitSha: record.commitSha,
      releasedAt: from.releasedAt,
      sourceUrl: recordSourceUrl(record),
      yanked: listed ? listed.yanked === true : null,
      yankedReason: listed?.yanked ? cleanReason(listed.yankedReason) : null,
    },
    local,
    releases,
    listingProblem,
    // The current release, when updating to it does something.
    suggested: current && (current.direction !== "same" || state.modified) ? current.version : null,
  };
}

/** The listing's releases a record could hold, newest first, each with which way it is from `from`. */
function pickable(listing: Extension, from: ReleaseRef): PickableRelease[] {
  const releases = listing.releases
    .filter((r) => isRecordedVersion(r.version))
    .map((r): PickableRelease => {
      const releasedAt = isoOrNull(r.releasedAt);
      return {
        version: r.version,
        gitTag: r.gitTag ? shownText(r.gitTag, 128) : null,
        commitSha: r.commitSha,
        releasedAt,
        yanked: r.yanked === true,
        current: r.version === listing.latestVersion,
        direction: updateDirection(from, { version: r.version, commitSha: r.commitSha, releasedAt }),
      };
    });
  // Newest first, by when each was published; one with no date goes last.
  const at = (r: PickableRelease) => (r.releasedAt ? Date.parse(r.releasedAt) : Number.NEGATIVE_INFINITY);
  return releases.map((r, i) => ({ r, i })).sort((a, b) => at(b.r) - at(a.r) || a.i - b.i).map(({ r }) => r);
}

/**
 * Which files of the folder differ from the installed release: downloaded as
 * install downloaded it, pinned and checked against the record's content
 * hash. When it can't be had, the dialog says the folder differs without
 * naming the files.
 */
async function listLocalChanges(installed: InstalledExtension): Promise<LocalChanges> {
  const { record } = installed;
  try {
    const release = await fetchRecordedRelease(record);
    return { state: "listed", ...localChangesBetween(installed.dir, installed.kind, release) };
  } catch (err) {
    console.warn(`[update] could not download ${installed.rel}'s installed release to compare with:`, err);
    return {
      state: "unlisted",
      reason:
        err instanceof ContentHashMismatch
          ? `What GitHub serves for ${record.version} no longer matches what was installed, so the files ` +
            "that changed can't be named."
          : `GitHub didn't serve ${record.version} at commit ${record.commitSha.slice(0, 12)}, so the files ` +
            "that changed can't be named.",
    };
  }
}

/** The overview, or why there is none. Reads only. */
export async function overviewForButton(input: unknown, ctx: UpdateContext): Promise<OverviewOutcome> {
  await ctx.admin();
  const target = TargetSchema.safeParse(input);
  if (!target.success) return notUpdatable();
  if (ctx.builtDeployment()) return builtDeployment();
  const { kind, slug } = target.data;
  const refused = await notInstallable(kind);
  if (refused) return refused;
  try {
    return { ok: true, overview: await updateOverview(kind, slug) };
  } catch (err) {
    return updateRefusal(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  The comparison                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything the dialog says about updating `kind`/`slug` to `version`. The
 * release is resolved, downloaded, verified against its content hash and
 * pre-flighted as install does it, in memory, and compared with the folder in
 * place: what its manifest declares, its migrations, the publisher's claims,
 * its floor, and which way it goes. Throws as install does.
 */
export async function compareUpdate(
  kind: ExtensionKind,
  slug: string,
  version: string,
  root: string = checkoutRoot(),
): Promise<UpdateComparison> {
  const installed = installedForUpdate(kind, slug, root);
  const { record } = installed;
  const host = sourceHost(record.source);
  const manifest = await resolveInstall(kind, slug, version);
  const origin = recordedOrigin(kind, slug, manifest);

  // The release as install would have it: pinned to its commit, verified,
  // pre-flighted, and with what install leaves out left out.
  const entries = await fetchExtensionTree({
    tarballUrl: manifest.tarballUrl,
    commitSha: manifest.commitSha,
    subpath: manifest.subpath ?? undefined,
  });
  verifyContentHash(entries, manifest.contentHash);
  preflight(kind, slug, entries);
  const { written } = leaveOut(entries);

  const [dates, claims] = await Promise.all([publishedDates(kind, slug), claimChanges(installed, host, manifest)]);
  const from: ReleaseRef = {
    version: record.version,
    commitSha: record.commitSha,
    releasedAt: dates.get(record.commitSha) ?? null,
  };
  const to: ReleaseRef = {
    version: manifest.version,
    commitSha: manifest.commitSha,
    releasedAt: dates.get(manifest.commitSha) ?? null,
  };
  const direction = updateDirection(from, to);
  const state = folderState(installed.dir, record);
  const before = readManifest(installed.dir, installed.kind);
  const after = releaseManifest(written, installed.kind);

  // GitHub's compare view runs from the older commit to the newer, in one repository.
  const sameRepo = sameRepository(record.repository, origin.repository);
  const [base, head] = direction === "older" ? [manifest.commitSha, record.commitSha] : [record.commitSha, manifest.commitSha];

  return {
    kind: installed.kind,
    slug,
    name: manifestName(before, installed.kind, slug),
    path: installed.rel,
    host,
    from: { ...from, gitTag: record.gitTag, sourceUrl: recordSourceUrl(record) },
    to: {
      ...to,
      gitTag: origin.gitTag,
      sourceUrl: githubSourceUrl(origin.repository, manifest.commitSha, origin.repository.subpath),
      contentHash: manifest.contentHash,
      yanked: manifest.yanked === true,
      yankedReason: manifest.yanked ? cleanReason(manifest.yankedReason) : null,
    },
    direction,
    compareUrl: sameRepo && direction !== "same" ? githubCompareUrl(record.repository, base, head) : null,
    otherRepository: sameRepo
      ? null
      : {
          from: `${record.repository.owner}/${record.repository.name}`,
          to: `${origin.repository.owner}/${origin.repository.name}`,
        },
    floor: floorVerdict(manifest.requiresMixOS),
    claims,
    // A theme runs no code: nothing it declares is enforced as an app's or a
    // connector's manifest is.
    declarations:
      installed.kind === "theme" ? [] : before && after ? compareDeclarations(installed.kind, before, after) : null,
    migrations:
      installed.kind === "app"
        ? compareMigrations(folderMigrations(installed.dir), releaseMigrations(written))
        : { added: [], changed: [], lacking: [] },
    localChanges: state.modified,
    needs: {
      discardLocalChanges: state.modified,
      allowOlder: needsOlderConsent(direction),
      allowYanked: manifest.yanked === true,
    },
    blocker:
      unhashableProblem(installed.rel, state) ??
      (direction === "same" && !state.modified
        ? `${installed.rel} already runs ${record.version}, and its files match it, so there is nothing to update.`
        : null),
    reviewed: {
      installedCommit: record.commitSha,
      installedFilesHash: record.filesHash,
      folderHash: state.folderHash,
      targetCommit: manifest.commitSha,
      targetContentHash: manifest.contentHash,
    },
  };
}

/**
 * How the publisher's claims change, from the installed release's on the
 * catalogue to the target's. Never throws: the comparison stands without
 * them, and says why.
 */
async function claimChanges(
  installed: InstalledExtension,
  host: string,
  target: InstallManifest,
): Promise<UpdateComparison["claims"]> {
  const { record } = installed;
  try {
    const was = await fetchInstallManifest(installed.kind, installed.slug, record.version);
    return { state: "ok", ...compareClaims(shownClaims(was.permissions), shownClaims(target.permissions)) };
  } catch {
    return {
      state: "unavailable",
      message: `${host} couldn't be asked for the publisher's claims for ${record.version}, which ${installed.rel} runs, so they can't be compared.`,
    };
  }
}

/** The comparison with the release the admin picked, or why there is none. Reads only. */
export async function compareForButton(input: unknown, ctx: UpdateContext): Promise<ComparisonOutcome> {
  await ctx.admin();
  const target = CompareInputSchema.safeParse(input);
  if (!target.success) return notUpdatable();
  if (ctx.builtDeployment()) return builtDeployment();
  const { kind, slug, version } = target.data;
  const refused = await notInstallable(kind);
  if (refused) return refused;
  try {
    return { ok: true, comparison: await compareUpdate(kind, slug, version) };
  } catch (err) {
    return updateRefusal(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  The update                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Make the update the admin reviewed: install's update mode, which leaves an
 * app's or a connector's release in `.mixos/pending/` with the folder in place
 * as it is, for Register to swap, and swaps a theme's there and then. Audited
 * as `<kind>.update`, with what it replaces and what it goes to, which way,
 * whether local changes were discarded, and for a theme that it was swapped;
 * refused, as `<kind>.update.rejected` with the reason, the built-deployment
 * refusal before any lock included.
 */
export async function updateFromButton(input: unknown, ctx: UpdateContext): Promise<UpdateOutcome> {
  const actor = await ctx.admin();
  const parsed = UpdateInputSchema.safeParse(input);
  if (!parsed.success) return notUpdatable();
  const { kind, slug, version, allowYanked, allowOlder, discardLocalChanges, reviewed } = parsed.data;

  const rejected = async (reason: string, message: string) =>
    recordAdminAction(actor, {
      action: `${kind}.update.rejected`,
      targetType: kind,
      targetId: slug,
      details: { via: "button", version, reason, message },
    });

  if (ctx.builtDeployment()) {
    await rejected("unsupported-environment", BUILT_DEPLOYMENT_UPDATE_NOTICE);
    return builtDeployment();
  }

  try {
    const result = await installExtension(kind, slug, {
      version,
      allowYanked,
      installedBy: actor.email,
      update: { discardLocalChanges, allowOlder, reviewed },
    });
    const replaces = result.replaces;
    if (!replaces) throw new Error("An update finished without recording what it replaces.");

    await recordAdminAction(actor, {
      action: `${kind}.update`,
      targetType: kind,
      targetId: slug,
      details: {
        via: "button",
        source: result.record.source,
        from: {
          version: replaces.version,
          gitTag: replaces.gitTag,
          commitSha: replaces.commitSha,
          filesHash: replaces.filesHash,
        },
        to: {
          version: result.version,
          gitTag: result.gitTag,
          commitSha: result.commitSha,
          contentHash: result.contentHash,
          filesHash: result.filesHash,
        },
        direction: replaces.direction,
        localChangesDiscarded: replaces.localChangesDiscarded,
        // An app or a connector waits in pending for Register; a theme was
        // swapped into place, and its backup deleted once the generator
        // accepted it.
        ...(result.pending
          ? { pendingPath: result.installPath }
          : { installPath: result.installPath, swapped: true, registryValidated: result.registry?.ok ?? null }),
        verdict: "accepted",
        deferred: result.deferred.length,
        fileCount: result.fileCount,
        byteCount: result.byteCount,
        leftOut: result.leftOut,
        yankedAccepted: allowYanked === true,
      },
    });
    ctx.revalidate(`/admin/${KIND_SEGMENT[kind]}`);

    return {
      ok: true,
      result: {
        kind: result.kind,
        slug,
        name: shownText(result.name) || slug,
        path: `${KIND_SEGMENT[kind]}/${slug}`,
        pendingPath: result.pending ? result.installPath : null,
        from: { version: replaces.version, gitTag: replaces.gitTag },
        to: { version: result.version, gitTag: result.gitTag, commitSha: result.commitSha },
        direction: replaces.direction,
        localChangesDiscarded: replaces.localChangesDiscarded,
        handBack: result.pending ? null : result.handBack,
        nextStep: result.nextStep,
      },
    };
  } catch (err) {
    const refusal = updateRefusal(err);
    // Never the detail, which can carry a generator's paths, nor the words of
    // an error nothing here expected.
    await rejected(refusal.code, refusal.code === "unknown" ? "An unexpected error stopped it." : refusal.message);
    return refusal;
  }
}
