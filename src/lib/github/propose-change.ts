/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Propose an update or a removal of an extension this build runs, as a pull
 * request on the linked repository: what "Propose update" on a notice or a
 * Browse card, and "Propose removal" in the Remove dialog, do on a built
 * deployment with the App linked. The steps are ./propose.ts's, with a tree
 * that replaces the extension's folder or deletes it. Rollback is reverting
 * the merge.
 *
 * ── WHAT IT CHANGES, AND WHAT IT HAS TO FIND ────────────────────────────────
 *
 * Only an extension `src/generated/registry-installs.ts` lists from this
 * instance's catalogue: the build's own record says which release it runs.
 * The folder on the default branch has to hold that same release: its
 * `.registry.json` records the same version, commit, catalogue and source
 * repository (changeFolderLine() in ./propose.ts), and its files are the
 * release the record names, byte for byte, which heldRelease() proves by
 * downloading that release pinned to its commit, checking it against the
 * record's content hash, and comparing git's id for the folder with the one
 * GitHub holds. Anything else is refused, naming the difference: a folder
 * someone edited on GitHub, or a default branch that moved on, isn't replaced
 * or deleted from here without being looked at in a checkout.
 *
 * An update goes to any release the admin picks, with the update dialog's
 * rules (src/lib/repository/update-admin.ts): a withdrawn one needs accepting,
 * an older one, by version or else by date, needs "Propose an older release",
 * and the MixOS floor is checked; the same release is nothing to do. The
 * comparison it shows is the update dialog's, computed between the release
 * the folder holds and the one it goes to, both in memory. Nothing touches
 * this instance's disk.
 *
 * A removal first applies the rules removing in a checkout applies
 * (dependentsOf() in src/lib/repository/remove.ts), from the manifests this
 * build registered: refused while an app requires the connector or uses the
 * app's services or hooks, or for the last theme; warned about an app that
 * uses the connector optionally and about the applied theme. The tree then
 * deletes every file under the folder, `.registry.json` included. The data
 * stays on each instance until an admin deletes it there.
 *
 * The step 2 checks, the branch-rule precondition, the preview checklist, the
 * write guard and the audit are exactly an install's: `<kind>.propose` with
 * `action: "update"` or `"remove"`, or `<kind>.propose.rejected`.
 */

import { z } from "zod";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { registryInstalls } from "@/generated/registry-installs";
import { themeRegistry } from "@/generated/theme-registry";
import { recordAdminAction } from "@/lib/apps/admin-audit";
import { floorVerdict } from "@/lib/platform/version";
import { RepositoryError, fetchExtension, fetchInstallManifest, repositoryBaseUrl } from "@/lib/repository/client";
import { contentHashesMatch, filesHash, verifyContentHash } from "@/lib/repository/content-hash";
import { fetchExtensionTree } from "@/lib/repository/fetch-source";
import {
  directionOf,
  fetchRecordedRelease,
  leaveOut,
  preflight,
  publishedDates,
  recordedOrigin,
  resolveInstall,
  verifyRelease,
  type VerifiedRelease,
} from "@/lib/repository/install";
import {
  INSTALL_RECORD_FILE,
  githubCompareUrl,
  githubSourceUrl,
  isRecordedVersion,
  type InstallRecord,
  type RegistryInstall,
} from "@/lib/repository/install-record";
import { sourceHost } from "@/lib/repository/provenance";
import {
  dependentsOf,
  storedTheme,
  type AppLinks,
  type RemovalNote,
  type ThemeInBuild,
} from "@/lib/repository/remove";
import { manifestName, runGroups, shownText } from "@/lib/repository/review";
import type { TarEntry } from "@/lib/repository/tar";
import { ExtensionKindSchema, SlugSchema, type Extension, type ExtensionKind, type InstallManifest } from "@/lib/repository/types";
import {
  compareClaims,
  compareDeclarations,
  compareMigrations,
  needsOlderConsent,
  releaseDifferences,
  releaseManifest,
  releaseMigrations,
  sameRepository,
  shownClaims,
  updateDirection,
  type ReleaseRef,
  type UpdateDirection,
} from "@/lib/repository/update";
import { isoOrNull, pickable } from "@/lib/repository/update-admin";
import type { ComparisonFacts } from "@/lib/repository/update-outcomes";
import { cleanReason } from "@/lib/repository/updates";
import { gitBlobSha, gitTreeSha } from "./git-objects";
import { locked, refused, ruleRecord, withLinkedRepository } from "./link";
import { repositoryUrl } from "./manifest";
import {
  removalProposalCommitMessage,
  removalProposalTitle,
  updateProposalCommitMessage,
  updateProposalTitle,
} from "./names";
import type {
  ChangeAction,
  ChangeProposalCheckOutcome,
  ProposeOutcome,
  UpdateProposalCompareOutcome,
} from "./outcomes";
import {
  ProposalRefusal,
  changeFolderLine,
  describe,
  inspect,
  judge,
  linkedState,
  nowOf,
  planFiles,
  precondition,
  readFolderAtHead,
  refusalFor,
  rejected,
  targetOf,
  thisHost,
  write,
  type FolderOnBranch,
  type Plan,
  type ProposeContext,
  type Target,
} from "./propose";
import { removalProposalBody, updateProposalBody } from "./pull-body";
import { readGitHubState, saveBranchRule } from "./store";

/**
 * What this build carries, as far as a change to it goes: the installs from
 * a Registry, every app and what it depends on, every theme, and each
 * extension's name. The generated registries, unless a test passes its own.
 */
export interface BuildFacts {
  installs: readonly RegistryInstall[];
  apps: readonly AppLinks[];
  /** Every theme, by name in order: pages use the first when none is applied. */
  themes: readonly ThemeInBuild[];
  /** The manifest's name for an extension in the build, or null when the build doesn't have it. */
  nameOf(kind: ExtensionKind, slug: string): string | null;
}

/** Who is proposing, the clock, and what the build and the database say. */
export interface ChangeContext extends ProposeContext {
  build?: BuildFacts;
  /** The theme this database applies, for a removal's warning (storedTheme() in remove.ts). */
  storedTheme?(): Promise<string | null | undefined>;
}

/** The build this code runs in, from the registries the generator wrote. */
export function thisBuild(): BuildFacts {
  return {
    installs: registryInstalls,
    apps: appRegistry.map((a) => ({
      slug: a.slug,
      name: a.name,
      connectors: a.connectors ?? [],
      optionalConnectors: a.optionalConnectors ?? [],
      consumes: (a.consumes ?? []).map((c) => c.app),
      listensTo: (a.listensTo ?? []).map((l) => l.app),
    })),
    themes: themeRegistry.map((t) => ({ slug: t.slug, name: t.name })).sort((a, b) => a.slug.localeCompare(b.slug)),
    nameOf(kind, slug) {
      if (kind === "app") return appRegistry.find((a) => a.slug === slug)?.name ?? null;
      if (kind === "connector") return connectorRegistry.find((c) => c.name === slug)?.displayName ?? null;
      return themeRegistry.find((t) => t.slug === slug)?.name ?? null;
    },
  };
}

const TargetInput = z.object({ kind: ExtensionKindSchema, slug: SlugSchema });
const CheckInput = TargetInput.extend({ action: z.enum(["update", "remove"]) });
const CompareInput = TargetInput.extend({ version: z.string().max(128).refine(isRecordedVersion) });
const UpdateInput = TargetInput.extend({
  version: z.string().max(128).optional(),
  allowYanked: z.boolean().optional(),
  allowOlder: z.boolean().optional(),
});

const NOT_IN_BUILD = "That isn't an extension in this build.";

const short = (sha: string) => sha.slice(0, 12);

/* -------------------------------------------------------------------------- */
/*  What this build runs                                                        */
/* -------------------------------------------------------------------------- */

/** The build's install of the target, from this instance's catalogue, or why there is none. */
function installedHere(build: BuildFacts, target: Target): RegistryInstall {
  const { kind, slug, folder } = target;
  const verb = target.action === "remove" ? "removed" : "updated";
  const install = build.installs.find((i) => i.kind === kind && i.slug === slug);
  if (!install) {
    throw new ProposalRefusal(
      refused(
        "not-installed",
        `${folder} isn't in this build with an install record from a catalogue, so it isn't ${verb} from here. ` +
          "A local extension is changed in a checkout.",
        "info",
      ),
    );
  }
  const catalogue = repositoryBaseUrl();
  if (install.source !== catalogue) {
    throw new ProposalRefusal(
      refused(
        "not-updatable",
        `${folder} was installed from ${sourceHost(install.source)}, and this instance installs from ` +
          `${sourceHost(catalogue)}, so it isn't ${verb} from here.`,
        "info",
      ),
    );
  }
  return install;
}

/** What the build's install says, with what the listing says of that release. */
function installedView(install: RegistryInstall, listing: Extension | null) {
  const listed = listing?.releases.find((r) => r.commitSha === install.commitSha) ?? null;
  return {
    version: install.version,
    gitTag: install.gitTag,
    commitSha: install.commitSha,
    releasedAt: isoOrNull(listed?.releasedAt),
    sourceUrl: githubSourceUrl(install.repository, install.commitSha, install.repository.subpath),
    yanked: listed ? listed.yanked === true : null,
    yankedReason: listed?.yanked ? cleanReason(listed.yankedReason) : null,
  };
}

/** The listing, or why it couldn't be read. */
async function listingOf(kind: ExtensionKind, slug: string, name: string, host: string) {
  try {
    return { listing: await fetchExtension(kind, slug), problem: null };
  } catch (err) {
    return {
      listing: null,
      problem:
        err instanceof RepositoryError && err.failure === "not-found"
          ? `${host} no longer lists ${name}, so there is no other release to update to.`
          : `${host} couldn't be asked which releases ${name} has: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Removal's refusals and warnings, from what this build registered. */
function removalNotes(ctx: ChangeContext, build: BuildFacts, kind: ExtensionKind, slug: string) {
  return dependentsOf(
    { here: "instance", apps: build.apps, themes: build.themes, storedTheme: ctx.storedTheme ?? storedTheme },
    kind,
    slug,
  );
}

/* -------------------------------------------------------------------------- */
/*  The folder on the default branch, against the release its record names     */
/* -------------------------------------------------------------------------- */

/** The release the folder on the default branch holds, proven to be the one its record names. */
interface Held {
  record: InstallRecord;
  /** The record's file, as the folder holds it. */
  text: string;
  /** The release's files, as install wrote them. */
  release: TarEntry[];
}

/** What differs between the folder and the release, in a phrase, for the refusal. */
function folderProblems(folder: FolderOnBranch, release: readonly TarEntry[], text: string): string {
  const expected = new Map(release.map((e) => [e.path, gitBlobSha(e.data)]));
  expected.set(INSTALL_RECORD_FILE, gitBlobSha(Buffer.from(text, "utf8")));
  const changed: string[] = [];
  const added: string[] = [];
  const odd: string[] = [];
  const seen = new Set<string>();
  for (const f of folder.files) {
    seen.add(f.path);
    const want = expected.get(f.path);
    if (want === undefined) added.push(f.path);
    else if (want !== f.sha) changed.push(f.path);
    else if (f.mode !== "100644" || f.type !== "blob") odd.push(f.path);
  }
  const missing = [...expected.keys()].filter((p) => !seen.has(p));
  const name = (list: string[], word: string) =>
    list.length === 0
      ? null
      : `${list.length} ${word} (${list
          .sort()
          .slice(0, 3)
          .map((p) => `\`${p}\``)
          .join(", ")}${list.length > 3 ? ", …" : ""})`;
  return (
    [name(changed, "changed"), name(added, "added"), name(missing, "missing"), name(odd, "not a plain file")]
      .filter((p): p is string => p !== null)
      .join(", ") || "its tree differs"
  );
}

/**
 * The folder on the default branch, judged as the dialog's Folder line judges
 * it, then its files against the release its record names: that release
 * downloaded pinned to its commit and checked against the record's content
 * hash, its files hash checked against the record's, and git's id for the
 * folder (the release's files and the record, every one a plain file)
 * compared with the id GitHub holds. Throws a refusal naming the difference.
 */
async function heldRelease(
  folder: FolderOnBranch | null,
  install: RegistryInstall,
  target: Target,
  branch: string,
): Promise<Held> {
  const line = changeFolderLine(folder, branch, target, install);
  if (!line.ok || !folder || folder.record.state !== "ok") {
    throw new ProposalRefusal(refused(line.code ?? "folder", `Not proposed. ${line.detail}`, "warning"));
  }
  const { record, text } = folder.record;
  const file = `${target.folder}/${INSTALL_RECORD_FILE}`;
  const release = await fetchRecordedRelease(record);
  if (!contentHashesMatch(filesHash(release), record.filesHash)) {
    throw new ProposalRefusal(
      refused(
        "folder-mismatch",
        `Not proposed. ${file} on ${branch} names a files hash that isn't release ${record.version}'s, so the folder ` +
          "isn't taken as that release. Sort it out in a checkout.",
        "warning",
      ),
    );
  }
  const expected = gitTreeSha([
    ...release.map((e) => ({ path: e.path, data: e.data })),
    { path: INSTALL_RECORD_FILE, data: Buffer.from(text, "utf8") },
  ]);
  if (expected !== folder.sha) {
    throw new ProposalRefusal(
      refused(
        "folder-mismatch",
        `Not proposed. ${target.folder} on ${branch} isn't release ${record.version} as its record says: ` +
          `${folderProblems(folder, release, text)}. Sort it out in a checkout, or deploy what ${branch} holds first.`,
        "warning",
      ),
      { folderTree: folder.sha, expectedTree: expected },
    );
  }
  return { record, text, release };
}

/* -------------------------------------------------------------------------- */
/*  The dialog's check                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the propose dialog shows when it opens for an update or a removal:
 * what this build runs and whether the default branch holds it, the releases
 * to pick from or what depends on it, the names, and step 2's lines. Nothing
 * is downloaded, nothing is written, and it isn't audited.
 */
export async function checkChangeProposal(input: unknown, ctx: ChangeContext): Promise<ChangeProposalCheckOutcome> {
  const actor = await ctx.admin();
  const parsed = CheckInput.safeParse(input);
  if (!parsed.success) return refused("input", NOT_IN_BUILD);
  const { action, kind, slug } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) return blocked;
  try {
    const state = await readGitHubState();
    if (!state.app || !state.link) return refused("not-linked", "Link a repository on Deployment > GitHub App first.", "info");
    const record = state.link.repository;
    const build = ctx.build ?? thisBuild();
    const target = targetOf(kind, slug, action);
    const install = installedHere(build, target);
    const onVercel = thisHost() === "vercel";
    const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, target, onVercel), ctx);
    const lines = judge(inspection, state, target, onVercel, install);

    const host = sourceHost(install.source);
    const name = shownText(build.nameOf(kind, slug) ?? slug) || slug;
    const { listing, problem } = await listingOf(kind, slug, name, host);
    const installed = installedView(install, listing);
    const from: ReleaseRef = { version: install.version, commitSha: install.commitSha, releasedAt: installed.releasedAt };
    const releases = action === "update" && listing ? pickable(listing, from) : [];
    const current = releases.find((r) => r.current);
    const removal = action === "remove" ? await removalNotes(ctx, build, kind, slug) : null;
    return {
      ok: true,
      action,
      repository: `${record.owner}/${record.name}`,
      repositoryUrl: repositoryUrl(record.owner, record.name),
      defaultBranch: record.defaultBranch,
      kind,
      slug,
      name,
      folder: target.folder,
      host,
      installed,
      onBranch: inspection.folder ? { files: inspection.folder.files.length } : null,
      releases,
      listingProblem: action === "update" ? problem : null,
      suggested: current && current.direction !== "same" ? current.version : null,
      removal,
      names: { branch: target.branch, title: action === "remove" ? removalProposalTitle(kind, slug) : null },
      lines,
      ready: lines.every((l) => l.ok) && (removal === null || removal.blockers.length === 0),
    };
  } catch (err) {
    return describe(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  The comparison                                                              */
/* -------------------------------------------------------------------------- */

/** How the publisher's claims change, from the release this build runs to the target. Never throws. */
async function claimChanges(
  kind: ExtensionKind,
  slug: string,
  installedVersion: string,
  host: string,
  target: InstallManifest,
): Promise<ComparisonFacts["claims"]> {
  try {
    const was = await fetchInstallManifest(kind, slug, installedVersion);
    return { state: "ok", ...compareClaims(shownClaims(was.permissions), shownClaims(target.permissions)) };
  } catch {
    return {
      state: "unavailable",
      message: `${host} couldn't be asked for the publisher's claims for ${installedVersion}, which this build runs, so they can't be compared.`,
    };
  }
}

/**
 * Everything the dialog says about updating the folder on the default branch
 * to `version`: the release resolved, downloaded, verified and pre-flighted as
 * install does it, the folder's release downloaded and proven, and the two
 * compared in memory, as the update dialog compares a checkout's folder with
 * a release. Reads only, and isn't audited.
 */
export async function compareUpdateProposal(input: unknown, ctx: ChangeContext): Promise<UpdateProposalCompareOutcome> {
  const actor = await ctx.admin();
  const parsed = CompareInput.safeParse(input);
  if (!parsed.success) return refused("input", NOT_IN_BUILD);
  const { kind, slug, version } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) return blocked;
  try {
    const state = await readGitHubState();
    if (!state.app || !state.link) return refused("not-linked", "Link a repository on Deployment > GitHub App first.", "info");
    const branch = state.link.repository.defaultBranch;
    const build = ctx.build ?? thisBuild();
    const target = targetOf(kind, slug, "update");
    const install = installedHere(build, target);
    const host = sourceHost(install.source);
    const manifest = await resolveInstall(kind, slug, version);
    const origin = recordedOrigin(kind, slug, manifest);

    // The release it goes to, as install would have it.
    const entries = await fetchExtensionTree({
      tarballUrl: manifest.tarballUrl,
      commitSha: manifest.commitSha,
      subpath: manifest.subpath ?? undefined,
    });
    verifyContentHash(entries, manifest.contentHash);
    preflight(kind, slug, entries);
    const { written } = leaveOut(entries);

    // The release the folder on the default branch holds.
    const { folder } = await withLinkedRepository("read", actor, (repo) => readFolderAtHead(repo, target), ctx);
    const held = await heldRelease(folder, install, target, branch);

    const [dates, claims] = await Promise.all([publishedDates(kind, slug), claimChanges(kind, slug, install.version, host, manifest)]);
    const from: ReleaseRef = { version: install.version, commitSha: install.commitSha, releasedAt: dates.get(install.commitSha) ?? null };
    const to: ReleaseRef = { version: manifest.version, commitSha: manifest.commitSha, releasedAt: dates.get(manifest.commitSha) ?? null };
    const direction = updateDirection(from, to);
    const before = releaseManifest(held.release, kind);
    const after = releaseManifest(written, kind);
    const sameRepo = sameRepository(held.record.repository, origin.repository);
    const [base, head] = direction === "older" ? [manifest.commitSha, install.commitSha] : [install.commitSha, manifest.commitSha];

    return {
      ok: true,
      kind,
      slug,
      name: shownText(build.nameOf(kind, slug) ?? slug) || slug,
      path: target.folder,
      host,
      from: { ...from, gitTag: install.gitTag, sourceUrl: githubSourceUrl(install.repository, install.commitSha, install.repository.subpath) },
      to: {
        ...to,
        gitTag: origin.gitTag,
        sourceUrl: githubSourceUrl(origin.repository, manifest.commitSha, origin.repository.subpath),
        contentHash: manifest.contentHash,
        yanked: manifest.yanked === true,
        yankedReason: manifest.yanked ? cleanReason(manifest.yankedReason) : null,
      },
      direction,
      compareUrl: sameRepo && direction !== "same" ? githubCompareUrl(held.record.repository, base, head) : null,
      otherRepository: sameRepo
        ? null
        : {
            from: `${held.record.repository.owner}/${held.record.repository.name}`,
            to: `${origin.repository.owner}/${origin.repository.name}`,
          },
      floor: floorVerdict(manifest.requiresMixOS),
      claims,
      declarations: kind === "theme" ? [] : before && after ? compareDeclarations(kind, before, after) : null,
      migrations:
        kind === "app"
          ? compareMigrations(releaseMigrations(held.release), releaseMigrations(written))
          : { added: [], changed: [], lacking: [] },
      files: releaseDifferences(held.release, written),
      needs: { discardLocalChanges: false, allowOlder: needsOlderConsent(direction), allowYanked: manifest.yanked === true },
      blocker:
        direction === "same"
          ? `${target.folder} on ${branch} already holds ${manifest.version}, so there is nothing to update.`
          : null,
      names: { branch: target.branch, title: updateProposalTitle(origin) },
    };
  } catch (err) {
    return describe(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Proposing an update                                                         */
/* -------------------------------------------------------------------------- */

/** What the tree writes for an update: the new release's files, and a deletion for each file the folder loses. */
async function planUpdate(
  target: Target,
  release: VerifiedRelease,
  held: Held,
  folder: FolderOnBranch,
  install: RegistryInstall,
  direction: UpdateDirection,
): Promise<Plan> {
  const { record, manifest, written, leftOut, tree } = release;
  const files = planFiles(target, tree);
  const kept = new Set(tree.map((e) => e.path));
  const deletions = folder.files
    .map((f) => f.path)
    .filter((p) => !kept.has(p))
    .sort()
    .map((p) => `${target.folder}/${p}`);
  const before = releaseManifest(held.release, target.kind);
  const after = releaseManifest(written, target.kind);
  const sameRepo = sameRepository(held.record.repository, record.repository);
  const [base, head] = direction === "older" ? [record.commitSha, install.commitSha] : [install.commitSha, record.commitSha];
  const listing = await fetchExtension(target.kind, target.slug).catch(() => null);
  const paths = written.map((e) => e.path);
  const body = updateProposalBody({
    record,
    from: { version: install.version, commitSha: install.commitSha },
    direction,
    changes: releaseDifferences(held.release, written),
    declarations: target.kind === "theme" ? [] : before && after ? compareDeclarations(target.kind, before, after) : null,
    migrations:
      target.kind === "app"
        ? compareMigrations(releaseMigrations(held.release), releaseMigrations(written))
        : { added: [], changed: [], lacking: [] },
    compareUrl: sameRepo && direction !== "same" ? githubCompareUrl(held.record.repository, base, head) : null,
    leftOut,
    runs: target.kind === "theme" ? null : runGroups(target.kind, paths),
    floor: floorVerdict(record.requiresMixOS),
    yanked: manifest.yanked ? { reason: manifest.yankedReason ?? null } : null,
    claims: { name: manifest.name, publisher: listing?.author.handle ?? null, permissions: manifest.permissions },
    host: thisHost(),
  });
  return {
    target,
    title: updateProposalTitle(record),
    message: updateProposalCommitMessage(record, { version: install.version, commitSha: install.commitSha, direction }),
    body,
    deletions,
    ...files,
  };
}

/**
 * Propose an update: the four steps, with the folder's release proven before
 * anything is written, and a tree that replaces the folder. Answers with the
 * pull request, or why not; either way audited.
 */
export async function proposeUpdate(input: unknown, ctx: ChangeContext): Promise<ProposeOutcome> {
  const actor = await ctx.admin();
  const parsed = UpdateInput.safeParse(input);
  if (!parsed.success) return refused("input", NOT_IN_BUILD);
  const { kind, slug, version, allowYanked, allowOlder } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) {
    await rejected(actor, kind, slug, version, blocked, { action: "update" });
    return blocked;
  }

  try {
    return await locked(async (lease) => {
      const { state, link } = await linkedState();
      const repository = `${link.repository.owner}/${link.repository.name}`;
      const branch = link.repository.defaultBranch;
      const build = ctx.build ?? thisBuild();
      const target = targetOf(kind, slug, "update");
      const install = installedHere(build, target);
      const onVercel = thisHost() === "vercel";

      // 1. In memory: the release it goes to, with which way it is from the
      //    one this build runs decided before anything is downloaded.
      let direction: UpdateDirection = "unknown";
      const release = await verifyRelease(kind, slug, { version, allowYanked }, async (manifest) => {
        direction = await directionOf(kind, install, manifest);
        if (direction === "same") {
          throw new ProposalRefusal(
            refused(
              "same-release",
              `${target.folder} already holds ${manifest.version} (commit ${short(manifest.commitSha)}), so there is nothing to update.`,
              "info",
            ),
          );
        }
        if (needsOlderConsent(direction) && !allowOlder) {
          throw new ProposalRefusal(
            refused(
              "older-release",
              direction === "older"
                ? `${manifest.version} is older than ${install.version}, which ${target.folder} holds. Choose "Propose an older release" to go back to it.`
                : `Which of ${install.version} and ${manifest.version} is newer can't be told. Choose "Propose an older release" to propose it anyway.`,
              "warning",
            ),
            { direction },
          );
        }
      });

      // 2. The repository, read again for this proposal, and the folder's
      //    files against the release its record names.
      const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, target, onVercel), ctx);
      await lease.assertHeld();
      await saveBranchRule(ruleRecord(link.repository, inspection.rules, nowOf(ctx)));
      const lines = judge(inspection, state, target, onVercel, install);
      const refusal = refusalFor(lines, repository);
      if (refusal) throw refusal;
      const held = await heldRelease(inspection.folder, install, target, branch);
      const planned = await planUpdate(target, release, held, inspection.folder!, install, direction);

      // 3. The writes, scoped to the folder: its files replaced, and the ones
      //    the new release lacks deleted.
      const opened = await withLinkedRepository("write", actor, (repo) => write(repo, planned, inspection, lease), {
        ...ctx,
        scope: { folder: target.folder, action: "update" },
      });

      // 4. The record.
      const r = release.record;
      await recordAdminAction(actor, {
        action: `${kind}.propose`,
        targetType: kind,
        targetId: slug,
        details: {
          action: "update",
          repositoryId: link.repository.id,
          repository,
          pullRequest: opened.number,
          url: opened.url,
          branch: target.branch,
          head: opened.head,
          base: branch,
          baseCommit: inspection.head,
          source: r.source,
          version: r.version,
          gitTag: r.gitTag,
          commitSha: r.commitSha,
          contentHash: r.contentHash,
          filesHash: r.filesHash,
          from: { version: install.version, gitTag: install.gitTag, commitSha: install.commitSha, filesHash: held.record.filesHash },
          direction,
          fileCount: planned.fileCount,
          byteCount: planned.byteCount,
          binaryFiles: planned.binary.length,
          deleted: planned.deletions.length,
          leftOut: release.leftOut,
          yankedAccepted: release.manifest.yanked === true,
          olderAccepted: needsOlderConsent(direction),
          branchRule: inspection.rules.pullRequest ? "rule" : "override",
          previewChecklistAt: state.previewChecklist?.at ?? null,
        },
      });
      return {
        ok: true,
        message:
          `Opened pull request #${opened.number} on ${repository}: ${target.folder} from ${install.version} to ${r.version}. ` +
          "Its checks run there. Merging it is the deploy, and reverting the merge is the way back.",
        links: [{ label: `Pull request #${opened.number}`, href: opened.url }],
        pullRequest: { number: opened.number, url: opened.url, branch: target.branch, head: opened.head },
      };
    });
  } catch (err) {
    const outcome = describe(err);
    await rejected(actor, kind, slug, version, outcome, { action: "update", ...(err instanceof ProposalRefusal ? err.details : {}) });
    return outcome;
  }
}

/* -------------------------------------------------------------------------- */
/*  Proposing a removal                                                         */
/* -------------------------------------------------------------------------- */

/** What the tree writes for a removal: a deletion for every file under the folder. */
function planRemoval(target: Target, held: Held, folder: FolderOnBranch, warnings: RemovalNote[]): Plan {
  const deletions = folder.files.map((f) => `${target.folder}/${f.path}`).sort();
  const r = held.record;
  const body = removalProposalBody({
    record: r,
    fileCount: deletions.length,
    warnings,
    claims: { name: manifestName(releaseManifest(held.release, target.kind), target.kind, target.slug) },
    host: thisHost(),
  });
  return {
    target,
    title: removalProposalTitle(target.kind, target.slug),
    message: removalProposalCommitMessage(r),
    body,
    text: [],
    binary: [],
    deletions,
    folderTree: null,
    fileCount: deletions.length,
    byteCount: 0,
  };
}

/**
 * Propose a removal: what depends on it first, from this build's manifests,
 * then the four steps with the folder's release proven and a tree that
 * deletes every file under it. Answers with the pull request, or why not;
 * either way audited.
 */
export async function proposeRemoval(input: unknown, ctx: ChangeContext): Promise<ProposeOutcome> {
  const actor = await ctx.admin();
  const parsed = TargetInput.safeParse(input);
  if (!parsed.success) return refused("input", NOT_IN_BUILD);
  const { kind, slug } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) {
    await rejected(actor, kind, slug, undefined, blocked, { action: "remove" });
    return blocked;
  }

  try {
    return await locked(async (lease) => {
      const { state, link } = await linkedState();
      const repository = `${link.repository.owner}/${link.repository.name}`;
      const branch = link.repository.defaultBranch;
      const build = ctx.build ?? thisBuild();
      const target = targetOf(kind, slug, "remove");
      const install = installedHere(build, target);
      const onVercel = thisHost() === "vercel";

      // 1. What depends on it, from what this build registered.
      const notes = await removalNotes(ctx, build, kind, slug);
      if (notes.blockers.length > 0) {
        throw new ProposalRefusal(
          refused(
            notes.blockers.some((b) => b.code === "last-theme") ? "last-theme" : "depended-on",
            `Not proposed. ${notes.blockers.map((b) => b.message).join(" ")}`,
            "warning",
          ),
          { blockers: notes.blockers.map((b) => b.code) },
        );
      }

      // 2. The repository, read again for this proposal, and the folder's
      //    files against the release its record names.
      const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, target, onVercel), ctx);
      await lease.assertHeld();
      await saveBranchRule(ruleRecord(link.repository, inspection.rules, nowOf(ctx)));
      const lines = judge(inspection, state, target, onVercel, install);
      const refusal = refusalFor(lines, repository);
      if (refusal) throw refusal;
      const held = await heldRelease(inspection.folder, install, target, branch);
      const planned = planRemoval(target, held, inspection.folder!, notes.warnings);

      // 3. The writes, scoped to the folder: every file under it deleted.
      const opened = await withLinkedRepository("write", actor, (repo) => write(repo, planned, inspection, lease), {
        ...ctx,
        scope: { folder: target.folder, action: "remove" },
      });

      // 4. The record.
      const r = held.record;
      await recordAdminAction(actor, {
        action: `${kind}.propose`,
        targetType: kind,
        targetId: slug,
        details: {
          action: "remove",
          repositoryId: link.repository.id,
          repository,
          pullRequest: opened.number,
          url: opened.url,
          branch: target.branch,
          head: opened.head,
          base: branch,
          baseCommit: inspection.head,
          source: r.source,
          version: r.version,
          gitTag: r.gitTag,
          commitSha: r.commitSha,
          contentHash: r.contentHash,
          filesHash: r.filesHash,
          fileCount: planned.fileCount,
          deleted: planned.deletions.length,
          warnings: notes.warnings.map((w) => w.code),
          branchRule: inspection.rules.pullRequest ? "rule" : "override",
          previewChecklistAt: state.previewChecklist?.at ?? null,
        },
      });
      return {
        ok: true,
        message:
          `Opened pull request #${opened.number} on ${repository}: it deletes ${target.folder}. Its checks run there. ` +
          "Merging it is the deploy; each instance keeps its data until an admin deletes it there, and reverting the " +
          "merge is the way back.",
        links: [{ label: `Pull request #${opened.number}`, href: opened.url }],
        pullRequest: { number: opened.number, url: opened.url, branch: target.branch, head: opened.head },
      };
    });
  } catch (err) {
    const outcome = describe(err);
    await rejected(actor, kind, slug, undefined, outcome, { action: "remove", ...(err instanceof ProposalRefusal ? err.details : {}) });
    return outcome;
  }
}

export type { ChangeAction };
