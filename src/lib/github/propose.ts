/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Propose an install as a pull request on the linked repository: what Browse's
 * "Propose to <owner>/<repo>" does on a built deployment with the App linked.
 * The work behind the actions in ./propose-actions.ts.
 *
 * ── THE STEPS ───────────────────────────────────────────────────────────────
 *
 * Under the `github.app` lock, so one proposal or link change runs at a time:
 *
 *   1. In memory (verifyRelease(), src/lib/repository/install.ts): ask the
 *      catalogue, refuse a withdrawn release not accepted and one that needs a
 *      newer MixOS than this build, download it pinned to its commit, check
 *      the content hash, pre-flight it, leave out `.gitignore` and
 *      `.gitattributes`, and work out the files hash and `.registry.json`.
 *      Nothing touches this instance's disk, and nothing runs the check: a
 *      built deployment can't, and the repository's CI and the production
 *      build's generator are the checks.
 *   2. With a read token: the default branch's head, its rules (again, before
 *      every proposal), every workflow in `.github/workflows/`, `render.yaml`,
 *      and on Vercel, `vercel.json` (./workflows.ts), all at that head; then
 *      whether the extension's folder is already on it, and whether the branch
 *      `mixos/install/<kind>-<slug>` exists. Any of them refuses, naming the
 *      file. So does a missing preview checklist, which an admin confirms for
 *      what the App can't read (Admin > GitHub).
 *   3. With a write token whose scope is the extension's folder: a blob for
 *      each binary file, one tree on the head's tree with every text file
 *      inline, every file 100644; a check that the folder GitHub stored is
 *      the tree that was verified; a commit with the head as its one parent;
 *      the branch; a pull request into the default branch. ./repository.ts
 *      refuses anything else.
 *   4. Audit `<kind>.propose`, with the pull request, its branch and the head
 *      commit the App made, or `<kind>.propose.rejected` with why.
 *
 * Names come from ./names.ts, the body from ./pull-body.ts. Nothing here
 * merges, touches the default branch or turns on auto-merge, and nothing could:
 * the client can't send the requests that would (./api.ts, ./repository.ts).
 *
 * checkProposal() runs step 2 without the lock, and without downloading
 * anything, for the dialog to show before the first proposal.
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { isBuiltDeployment } from "@/lib/platform/build";
import { LockLostError, LockUnavailableError, type PlatformLease } from "@/lib/platform/lock";
import { floorVerdict } from "@/lib/platform/version";
import { RepositoryError, fetchExtension, repositoryBaseUrl } from "@/lib/repository/client";
import { ContentHashMismatch } from "@/lib/repository/content-hash";
import { SourceFetchError } from "@/lib/repository/fetch-source";
import { InstallError, resolveInstall, verifyRelease, type VerifiedRelease } from "@/lib/repository/install";
import { installDisabledMessage, installEnabled } from "@/lib/repository/policy";
import { kindDir } from "@/lib/repository/pending";
import { runGroups, shownText } from "@/lib/repository/review";
import { ArchiveError } from "@/lib/repository/tar";
import { ExtensionKindSchema, SlugSchema, type ExtensionKind } from "@/lib/repository/types";
import { GitHubError, segment } from "./api";
import { gitBlobSha, gitTreeSha, isInlineText } from "./git-objects";
import {
  GitHubLinkError,
  branchRuleSatisfied,
  featureRefusal,
  fromError,
  locked,
  refused,
  ruleRecord,
  withLinkedRepository,
  type LinkContext,
} from "./link";
import { repositoryUrl } from "./manifest";
import { extensionFolder, proposalBranch, proposalCommitMessage, proposalTitle } from "./names";
import type {
  GitHubOutcome,
  ProposalCheckLine,
  ProposalCheckOutcome,
  ProposalFinding,
  ProposalTarget,
  ProposeOutcome,
} from "./outcomes";
import { proposalBody, type Host } from "./pull-body";
import { readBranchRulesOrNone, type BranchRules, type LinkedRepository } from "./repository";
import {
  ContentDirectorySchema,
  ContentFileSchema,
  GitBlobCreatedSchema,
  GitCommitSchema,
  GitRefSchema,
  GitTreeSchema,
  PullRequestSchema,
  parseAnswer,
} from "./schemas";
import { readGitHubState, saveBranchRule, type GitHubState } from "./store";
import { RENDER_FIX, WORKFLOW_FIX, checkRenderYaml, checkVercelJson, checkWorkflow, type Finding } from "./workflows";

/** Who is proposing, and the clock. */
export type ProposeContext = Pick<LinkContext, "admin" | "now">;

const nowOf = (ctx: { now?(): Date }) => (ctx.now ? ctx.now() : new Date());

/** More workflow files than this aren't read: the proposal is refused instead. */
const MAX_WORKFLOWS = 50;
/** A repository file larger than this isn't read (the contents API gives 1 MB). */
const MAX_FILE_BYTES = 512 * 1024;
/**
 * Each binary file is a request of its own, and GitHub allows about 80
 * content-creating requests a minute and 500 an hour. Text goes inline, in the
 * one tree.
 */
export const MAX_BINARY_FILES = 40;
/** The package's files, together: they go to GitHub in request bodies. */
export const MAX_PROPOSAL_BYTES = 20 * 1024 * 1024;

/** Where this instance runs, for what merging does (./pull-body.ts). */
export function thisHost(env: Readonly<Record<string, string | undefined>> = process.env): Host {
  if (env.VERCEL) return "vercel";
  if (env.RENDER || env.RENDER_SERVICE_ID) return "render";
  if (env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID) return "railway";
  return "image";
}

/** A refusal with what to tell the admin, and what the audit row adds. */
class ProposalRefusal extends Error {
  constructor(
    readonly outcome: Extract<ProposeOutcome, { ok: false }>,
    readonly details: Record<string, unknown> = {},
  ) {
    super(outcome.message);
    this.name = "ProposalRefusal";
  }
}

const InputSchema = z.object({
  kind: ExtensionKindSchema,
  slug: SlugSchema,
  version: z.string().max(128).optional(),
  allowYanked: z.boolean().optional(),
});

/** What stops a proposal before GitHub is asked anything, or null. */
function precondition(kind: ExtensionKind): Extract<GitHubOutcome, { ok: false }> | null {
  if (!installEnabled(kind)) return refused("disabled", installDisabledMessage(kind));
  if (!isBuiltDeployment()) {
    return refused(
      "checkout",
      "This is a checkout. Install and register here, then commit. Proposing is for a deployed instance.",
      "info",
    );
  }
  return featureRefusal();
}

/* -------------------------------------------------------------------------- */
/*  Browse: whether to offer it                                                 */
/* -------------------------------------------------------------------------- */

/** Why proposals are off, from what is stored, or null when they can go ahead as far as it knows. */
function offReason(state: GitHubState): string | null {
  if (!state.link) return "Nothing is linked.";
  if (state.link.disabled) return "The GitHub link is off. Check again on Admin > GitHub.";
  if (!branchRuleSatisfied(state).ok) {
    return (
      `No pull_request rule applies to ${state.link.repository.defaultBranch}. Add a ruleset, or confirm ` +
      "another protection, on Admin > GitHub."
    );
  }
  if (!state.previewChecklist) {
    return "Confirm on Admin > GitHub that no host builds previews of the App's branches.";
  }
  return null;
}

/**
 * Whether Browse offers "Propose to <owner>/<repo>" for `kind`, from what is
 * stored, without asking GitHub: a built deployment, installing the kind
 * allowed, the App on and linked. The caller has required an admin.
 */
export async function proposalTarget(kind: ExtensionKind): Promise<ProposalTarget | null> {
  if (!installEnabled(kind) || !isBuiltDeployment() || featureRefusal()) return null;
  let state: GitHubState;
  try {
    state = await readGitHubState();
  } catch {
    // A record that can't be read: Admin > GitHub says so.
    return null;
  }
  if (!state.app || !state.link) return null;
  return {
    repository: `${state.link.repository.owner}/${state.link.repository.name}`,
    off: offReason(state),
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading the repository                                                      */
/* -------------------------------------------------------------------------- */

/** `/contents/<path>`, a segment at a time. */
function contentsPath(path: string): string {
  return `/contents/${path.split("/").map(segment).join("/")}`;
}

/** GET, or null on a 404. */
async function getOrNull(repo: LinkedRepository, suffix: string, params?: URLSearchParams): Promise<unknown | null> {
  try {
    return await repo.get(suffix, params);
  } catch (err) {
    if (err instanceof GitHubError && err.failure === "not-found") return null;
    throw err;
  }
}

/** A folder's entries at `ref`, or null when there is no such folder. Throws when it is a file. */
async function readFolder(repo: LinkedRepository, path: string, ref: string) {
  const data = await getOrNull(repo, contentsPath(path), new URLSearchParams({ ref }));
  if (data === null) return null;
  if (!Array.isArray(data)) {
    throw new GitHubError(`${path} on the default branch isn't a folder, so nothing was proposed.`, "malformed");
  }
  return parseAnswer(ContentDirectorySchema, data, "GET /repos/{owner}/{repo}/contents/{path}");
}

/** A file's text at `ref`: null when there is none, or why it can't be read. */
async function readText(
  repo: LinkedRepository,
  path: string,
  ref: string,
): Promise<{ text: string } | { problem: string } | null> {
  const data = await getOrNull(repo, contentsPath(path), new URLSearchParams({ ref }));
  if (data === null) return null;
  const file = ContentFileSchema.safeParse(data);
  if (!file.success) return { problem: "isn't a file the check can read: it may be a link or a folder." };
  if (file.data.encoding !== "base64" || file.data.size > MAX_FILE_BYTES) {
    return { problem: "is too large for the check to read." };
  }
  return { text: Buffer.from(file.data.content, "base64").toString("utf8") };
}

/** A branch's head commit, or null when there is no such branch. */
async function branchHead(repo: LinkedRepository, branch: string): Promise<string | null> {
  const data = await getOrNull(repo, `/git/ref/heads/${branch.split("/").map(segment).join("/")}`);
  if (data === null) return null;
  const ref = parseAnswer(GitRefSchema, data, "GET /repos/{owner}/{repo}/git/ref/{ref}");
  if (ref.ref !== `refs/heads/${branch}` || ref.object.type !== "commit") {
    throw new GitHubError(`GitHub answered for another ref than refs/heads/${branch}.`, "malformed");
  }
  return ref.object.sha;
}

/** What the proposal is of. */
interface Target {
  kind: ExtensionKind;
  slug: string;
  folder: string;
  branch: string;
}

function targetOf(kind: ExtensionKind, slug: string): Target {
  return { kind, slug, folder: extensionFolder(kind, slug), branch: proposalBranch(kind, slug) };
}

/** What step 2 read. */
interface Inspection {
  /** The default branch's head commit, and its tree: what the proposal builds on. */
  head: string;
  baseTree: string;
  rules: BranchRules;
  /** Workflows, render.yaml and vercel.json, file by file. */
  findings: Finding[];
  workflowCount: number;
  renderYaml: boolean;
  folderExists: boolean;
  branchExists: boolean;
}

/** Step 2: everything read at the default branch's head, with `repo`'s read token. */
async function inspect(repo: LinkedRepository, target: Target, onVercel: boolean): Promise<Inspection> {
  const defaultBranch = repo.record.defaultBranch;
  const head = await branchHead(repo, defaultBranch);
  if (!head) {
    throw new GitHubError(
      `GitHub has no branch ${defaultBranch}, the default branch on record. Check again on Admin > GitHub.`,
      "not-found",
    );
  }
  const commit = parseAnswer(GitCommitSchema, await repo.get(`/git/commits/${head}`), "GET /repos/{owner}/{repo}/git/commits/{sha}");
  if (commit.sha !== head) throw new GitHubError("GitHub answered for another commit than the one asked for.", "malformed");
  const rules = await readBranchRulesOrNone(repo);

  const findings: Finding[] = [];
  const where = { defaultBranch, branch: target.branch };
  const workflows = ((await readFolder(repo, ".github/workflows", head)) ?? []).filter((e) => /\.ya?ml$/i.test(e.name));
  if (workflows.length > MAX_WORKFLOWS) {
    findings.push({
      file: ".github/workflows",
      problem: `holds ${workflows.length} workflows, more than the check reads (${MAX_WORKFLOWS}).`,
    });
  } else {
    for (const entry of workflows) {
      const file = `.github/workflows/${entry.name}`;
      if (entry.type !== "file") {
        findings.push({ file, problem: "is a link or a folder, so the check can't read it." });
        continue;
      }
      const read = await readText(repo, file, head);
      if (read === null) findings.push({ file, problem: "went away while it was being read. Try again." });
      else if ("problem" in read) findings.push({ file, problem: read.problem });
      else findings.push(...checkWorkflow(file, read.text, where));
    }
  }

  const render = await readText(repo, "render.yaml", head);
  if (render && "problem" in render) findings.push({ file: "render.yaml", problem: render.problem });
  else if (render) findings.push(...checkRenderYaml(render.text));

  if (onVercel) {
    const vercel = await readText(repo, "vercel.json", head);
    if (vercel && "problem" in vercel) findings.push({ file: "vercel.json", problem: vercel.problem });
    else findings.push(...checkVercelJson(vercel ? vercel.text : null, target.branch));
  }

  // On a case-insensitive checkout, apps/Files is apps/files.
  const siblings = (await readFolder(repo, kindDir(target.kind), head)) ?? [];
  const folderExists = siblings.some((e) => e.name.normalize("NFC").toLowerCase() === target.slug);
  const branchExists = (await branchHead(repo, target.branch)) !== null;

  return {
    head,
    baseTree: commit.tree.sha,
    rules,
    findings,
    workflowCount: workflows.length,
    renderYaml: render !== null,
    folderExists,
    branchExists,
  };
}

/* -------------------------------------------------------------------------- */
/*  Judging what was read                                                       */
/* -------------------------------------------------------------------------- */

const isWorkflowFile = (f: Finding) => f.file.startsWith(".github/");
const asFindings = (found: Finding[]): ProposalFinding[] => found.map((f) => ({ file: f.file, problem: f.problem }));

/** The dialog's lines, in the order a refusal names them. */
function judge(inspection: Inspection, state: GitHubState, target: Target, onVercel: boolean): ProposalCheckLine[] {
  const branch = inspection.rules.branch;
  const viaRule = inspection.rules.pullRequest;
  const lines: ProposalCheckLine[] = [];

  lines.push({
    id: "rule",
    ok: viaRule || state.override !== null,
    label: "Branch rule",
    detail: viaRule
      ? `A pull_request rule applies to ${branch}.`
      : state.override
        ? `An admin confirmed another protection on ${branch}.`
        : inspection.rules.unreadStatus !== undefined
          ? `GitHub didn't let the App read the rules on ${branch} (${inspection.rules.unreadStatus}), and no other protection is confirmed. Confirm one on Admin > GitHub.`
          : `No pull_request rule applies to ${branch}. Add a ruleset, or confirm another protection, on Admin > GitHub.`,
  });

  lines.push({
    id: "checklist",
    ok: state.previewChecklist !== null,
    label: "Previews elsewhere",
    detail: state.previewChecklist
      ? `${state.previewChecklist.by} confirmed nothing else builds the App's branches.`
      : "Confirm on Admin > GitHub that no host builds previews of the App's branches. The App can't read those settings.",
  });

  const workflowFindings = inspection.findings.filter(isWorkflowFile);
  lines.push({
    id: "workflows",
    ok: workflowFindings.length === 0,
    label: "Workflows",
    detail:
      workflowFindings.length === 0
        ? inspection.workflowCount === 0
          ? "None in .github/workflows."
          : `${inspection.workflowCount} checked. None would run this pull request with a secret or a token that can write.`
        : WORKFLOW_FIX,
    ...(workflowFindings.length > 0 ? { findings: asFindings(workflowFindings) } : {}),
  });

  if (inspection.renderYaml) {
    const found = inspection.findings.filter((f) => f.file === "render.yaml");
    lines.push({
      id: "render",
      ok: found.length === 0,
      label: "render.yaml",
      detail: found.length === 0 ? "Previews are off." : RENDER_FIX,
      ...(found.length > 0 ? { findings: asFindings(found) } : {}),
    });
  }
  if (onVercel) {
    const found = inspection.findings.filter((f) => f.file === "vercel.json");
    lines.push({
      id: "vercel",
      ok: found.length === 0,
      label: "vercel.json",
      detail: found.length === 0 ? "Vercel doesn't deploy the App's branches." : `vercel.json ${found[0].problem}`,
    });
  }

  lines.push({
    id: "folder",
    ok: !inspection.folderExists,
    label: "Folder",
    detail: inspection.folderExists
      ? `${target.folder} is already on ${branch}.`
      : `${target.folder} isn't on ${branch} yet.`,
  });
  lines.push({
    id: "branch",
    ok: !inspection.branchExists,
    label: "Branch",
    detail: inspection.branchExists
      ? `${target.branch} already exists. Merge or close its pull request and delete the branch, then propose again.`
      : `${target.branch} doesn't exist yet.`,
  });
  return lines;
}

/** The first line that doesn't hold, as a refusal, or null. */
function refusalFor(lines: ProposalCheckLine[], repository: string): ProposalRefusal | null {
  const failed = lines.find((l) => !l.ok);
  if (!failed) return null;
  const code =
    failed.id === "rule"
      ? "branch-rule"
      : failed.id === "folder"
        ? "folder-exists"
        : failed.id === "branch"
          ? "branch-exists"
          : failed.id;
  const findings = lines.flatMap((l) => l.findings ?? []);
  // File names in backticks, which the dialog shows as code.
  const named = findings.length > 0 ? ` ${findings.map((f) => `\`${f.file}\` ${f.problem}`).join(" ")}` : "";
  const message =
    failed.id === "workflows" || failed.id === "render"
      ? `Not proposed: something in ${repository} would run it with secrets.${named} ${failed.detail}`
      : `Not proposed. ${failed.detail}`;
  return new ProposalRefusal(
    {
      ok: false,
      code,
      message: message.replace(/\s+/g, " ").trim(),
      tone: failed.id === "folder" || failed.id === "branch" ? "warning" : "danger",
      ...(findings.length > 0 ? { findings } : {}),
    },
    { files: [...new Set(findings.map((f) => f.file))] },
  );
}

/* -------------------------------------------------------------------------- */
/*  Before the first proposal: the dialog's check                               */
/* -------------------------------------------------------------------------- */

/**
 * What the propose dialog shows when it opens: the release (asked of the
 * catalogue, not downloaded), the names, and step 2, read with a read token.
 * Changes nothing, and isn't audited, but a widened installation found on the
 * way still switches the link off (./link.ts).
 */
export async function checkProposal(input: unknown, ctx: ProposeContext): Promise<ProposalCheckOutcome> {
  const actor = await ctx.admin();
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return refused("input", "That isn't an extension in the catalogue.");
  const { kind, slug } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) return blocked;
  try {
    const state = await readGitHubState();
    if (!state.app || !state.link) return refused("not-linked", "Link a repository on Admin > GitHub first.", "info");
    const record = state.link.repository;
    const target = targetOf(kind, slug);
    const manifest = await resolveInstall(kind, slug);
    const listing = await fetchExtension(kind, slug).catch(() => null);
    const title = proposalTitle({ source: repositoryBaseUrl(), kind, slug, version: manifest.version });
    const onVercel = thisHost() === "vercel";
    const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, target, onVercel), ctx);
    const lines = judge(inspection, state, target, onVercel);
    return {
      ok: true,
      repository: `${record.owner}/${record.name}`,
      repositoryUrl: repositoryUrl(record.owner, record.name),
      defaultBranch: record.defaultBranch,
      release: {
        version: manifest.version,
        gitTag: manifest.gitTag ?? null,
        commitSha: manifest.commitSha,
        contentHash: manifest.contentHash,
        subpath: manifest.subpath ?? null,
        yanked: manifest.yanked === true,
        yankedReason: manifest.yankedReason ? shownText(manifest.yankedReason, 400) : null,
      },
      source: listing
        ? { owner: listing.sourceRepo.owner, name: listing.sourceRepo.name, url: listing.sourceRepo.url }
        : null,
      floor: floorVerdict(manifest.requiresMixOS),
      names: { branch: target.branch, title, folder: target.folder },
      lines,
      ready: lines.every((l) => l.ok),
      permissions: manifest.permissions.map((p) => ({ scope: shownText(p.scope, 120), reason: shownText(p.reason, 400) })),
    };
  } catch (err) {
    return describe(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Proposing                                                                   */
/* -------------------------------------------------------------------------- */

/** What step 3 writes, worked out from what step 1 verified. */
interface Plan {
  target: Target;
  title: string;
  message: string;
  body: string;
  /** Repository paths, under the folder. */
  text: { path: string; content: string }[];
  binary: { path: string; data: Buffer }[];
  /** The id of the folder's tree, as git would make it from these files. */
  folderTree: string;
  fileCount: number;
  byteCount: number;
}

async function plan(target: Target, release: VerifiedRelease): Promise<Plan> {
  const { record, manifest, written, leftOut, tree } = release;
  const byteCount = tree.reduce((n, e) => n + e.data.length, 0);
  const text: Plan["text"] = [];
  const binary: Plan["binary"] = [];
  for (const entry of tree) {
    const path = `${target.folder}/${entry.path}`;
    if (isInlineText(entry.data)) text.push({ path, content: entry.data.toString("utf8") });
    else binary.push({ path, data: entry.data });
  }
  if (binary.length > MAX_BINARY_FILES) {
    throw new ProposalRefusal(
      refused(
        "too-many-binary-files",
        `Not proposed: it has ${binary.length} binary files, and the App sends at most ${MAX_BINARY_FILES}, each a ` +
          "request GitHub counts against its limits. Install it in a checkout instead.",
      ),
    );
  }
  if (byteCount > MAX_PROPOSAL_BYTES) {
    throw new ProposalRefusal(
      refused(
        "too-large",
        `Not proposed: it is ${Math.ceil(byteCount / 1024 / 1024)} MB, more than the App sends ` +
          `(${MAX_PROPOSAL_BYTES / 1024 / 1024} MB). Install it in a checkout instead.`,
      ),
    );
  }

  const listing = await fetchExtension(target.kind, target.slug).catch(() => null);
  const paths = written.map((e) => e.path);
  const body = proposalBody({
    record,
    leftOut,
    runs: target.kind === "theme" ? null : runGroups(target.kind, paths),
    migrations: target.kind === "app" ? paths.filter((p) => /^migrations\/[^/]+\.sql$/.test(p)).length : 0,
    floor: floorVerdict(record.requiresMixOS),
    yanked: manifest.yanked ? { reason: manifest.yankedReason ?? null } : null,
    claims: {
      name: manifest.name,
      publisher: listing?.author.handle ?? null,
      permissions: manifest.permissions,
    },
    host: thisHost(),
  });
  return {
    target,
    title: proposalTitle(record),
    message: proposalCommitMessage(record),
    body,
    text,
    binary,
    folderTree: gitTreeSha(tree.map((e) => ({ path: e.path, data: e.data }))),
    fileCount: tree.length,
    byteCount,
  };
}

/** What step 3 made. */
interface Opened {
  number: number;
  url: string;
  head: string;
}

/**
 * Check that the folder in GitHub's new tree is the one git makes of the
 * verified files: GitHub stored those bytes, and nothing else, under it.
 */
async function assertFolder(repo: LinkedRepository, root: { tree: { path: string; type: string; sha: string }[]; truncated: boolean }, plan: Plan): Promise<void> {
  const [top, name] = plan.target.folder.split("/");
  const parent = root.tree.find((e) => e.path === top && e.type === "tree");
  if (root.truncated || !parent) {
    throw new GitHubError(`GitHub's new tree doesn't show ${top}/, so nothing was pushed.`, "malformed");
  }
  const level = parseAnswer(GitTreeSchema, await repo.get(`/git/trees/${parent.sha}`), "GET /repos/{owner}/{repo}/git/trees/{sha}");
  const folder = level.tree.find((e) => e.path === name && e.type === "tree");
  if (!folder || folder.sha !== plan.folderTree) {
    throw new GitHubError(
      `What GitHub stored for ${plan.target.folder} isn't the tree that was verified, so nothing was pushed.`,
      "malformed",
    );
  }
}

/** Step 3, with a write token scoped to the folder. */
async function write(repo: LinkedRepository, plan: Plan, inspection: Inspection, lease: PlatformLease): Promise<Opened> {
  const record = repo.record;
  const entries: Record<string, string>[] = [];
  for (const file of plan.binary) {
    const blob = parseAnswer(
      GitBlobCreatedSchema,
      await repo.post("/git/blobs", { content: file.data.toString("base64"), encoding: "base64" }),
      "POST /repos/{owner}/{repo}/git/blobs",
    );
    if (blob.sha !== gitBlobSha(file.data)) {
      throw new GitHubError("GitHub stored a different file than was sent, so nothing was pushed.", "malformed");
    }
    entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const file of plan.text) entries.push({ path: file.path, mode: "100644", type: "blob", content: file.content });

  const tree = parseAnswer(
    GitTreeSchema,
    await repo.post("/git/trees", { base_tree: inspection.baseTree, tree: entries }),
    "POST /repos/{owner}/{repo}/git/trees",
  );
  await assertFolder(repo, tree, plan);

  const commit = parseAnswer(
    GitCommitSchema,
    await repo.post("/git/commits", { message: plan.message, tree: tree.sha, parents: [inspection.head] }),
    "POST /repos/{owner}/{repo}/git/commits",
  );
  if (commit.tree.sha !== tree.sha || commit.parents.length !== 1 || commit.parents[0].sha !== inspection.head) {
    throw new GitHubError("GitHub made a different commit than was asked for, so nothing was pushed.", "malformed");
  }

  // The branch is the first thing anyone else sees. Nothing goes up without the lock.
  const branch = plan.target.branch;
  const compare = `${repositoryUrl(record.owner, record.name)}/compare/${record.defaultBranch
    .split("/")
    .map(encodeURIComponent)
    .join("/")}...${branch.split("/").map(encodeURIComponent).join("/")}`;
  /** A refusal once the branch may be on GitHub: say so, and how to finish or undo it. */
  const leftBranch = (what: string, created: boolean | "unknown") =>
    new ProposalRefusal(
      refused(
        "pull-request",
        `${what}. Look for ${branch} on GitHub: open a pull request from it if there isn't one, or delete it ` +
          "and propose again.",
        "danger",
        [{ label: "The branch on GitHub", href: compare }],
      ),
      { branchCreated: created, branch, head: commit.sha },
    );
  const unsure = (err: unknown) =>
    err instanceof GitHubError && (err.failure === "malformed" || err.failure === "unreachable");

  await lease.assertHeld();
  let ref;
  try {
    ref = parseAnswer(
      GitRefSchema,
      await repo.post("/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha }),
      "POST /repos/{owner}/{repo}/git/refs",
    );
  } catch (err) {
    // A refusal from GitHub made nothing; an answer that didn't come back whole may have.
    if (unsure(err)) throw leftBranch("GitHub's answer to creating the branch didn't come back whole", "unknown");
    throw err;
  }
  if (ref.object.sha !== commit.sha) throw leftBranch("GitHub put the branch at another commit", true);

  let pull;
  try {
    await lease.assertHeld();
    pull = parseAnswer(
      PullRequestSchema,
      await repo.post("/pulls", { title: plan.title, head: branch, base: record.defaultBranch, body: plan.body }),
      "POST /repos/{owner}/{repo}/pulls",
    );
  } catch (err) {
    throw leftBranch(
      err instanceof GitHubError
        ? `The branch was pushed, but GitHub didn't confirm the pull request (${err.message.replace(/[.\s]+$/, "")})`
        : "The branch was pushed, but the pull request wasn't opened",
      true,
    );
  }
  if (pull.head.ref !== branch || pull.base.ref !== record.defaultBranch || pull.head.sha !== commit.sha) {
    throw new GitHubError(`GitHub's pull request #${pull.number} isn't the one asked for. Look at it on GitHub.`, "malformed");
  }
  return {
    number: pull.number,
    url: `${repositoryUrl(record.owner, record.name)}/pull/${pull.number}`,
    head: commit.sha,
  };
}

/**
 * Propose an install: the module comment's four steps. Answers with the pull
 * request, or why not; either way audited.
 */
export async function proposeInstall(input: unknown, ctx: ProposeContext): Promise<ProposeOutcome> {
  const actor = await ctx.admin();
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return refused("input", "That isn't an extension in the catalogue.");
  const { kind, slug, version, allowYanked } = parsed.data;
  const blocked = precondition(kind);
  if (blocked) {
    await rejected(actor, kind, slug, version, blocked, {});
    return blocked;
  }

  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app || !state.link) {
        throw new ProposalRefusal(refused("not-linked", "Link a repository on Admin > GitHub first.", "info"));
      }
      if (state.link.disabled) {
        throw new ProposalRefusal(
          refused("disabled", `The GitHub link is off: ${state.link.disabled.detail} Check again on Admin > GitHub.`, "danger"),
        );
      }
      // Stored, so it can't change while this runs: refused before anything is downloaded.
      if (!state.previewChecklist) {
        throw new ProposalRefusal(
          refused(
            "checklist",
            "Not proposed. Confirm on Admin > GitHub that no host builds previews of the App's branches. The App " +
              "can't read those settings.",
            "danger",
          ),
        );
      }
      const link = state.link;
      const repository = `${link.repository.owner}/${link.repository.name}`;
      const target = targetOf(kind, slug);
      const onVercel = thisHost() === "vercel";

      // 1. In memory.
      const release = await verifyRelease(kind, slug, { version, allowYanked });
      const planned = await plan(target, release);

      // 2. The repository, read again for this proposal.
      const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, target, onVercel), ctx);
      await lease.assertHeld();
      await saveBranchRule(ruleRecord(link.repository, inspection.rules, nowOf(ctx)));
      const lines = judge(inspection, state, target, onVercel);
      const refusal = refusalFor(lines, repository);
      if (refusal) throw refusal;

      // 3. The writes, scoped to the folder.
      const opened = await withLinkedRepository("write", actor, (repo) => write(repo, planned, inspection, lease), {
        ...ctx,
        scope: { folder: target.folder },
      });

      // 4. The record.
      const r = release.record;
      await recordAdminAction(actor, {
        action: `${kind}.propose`,
        targetType: kind,
        targetId: slug,
        details: {
          repositoryId: link.repository.id,
          repository,
          pullRequest: opened.number,
          url: opened.url,
          branch: target.branch,
          head: opened.head,
          base: link.repository.defaultBranch,
          baseCommit: inspection.head,
          source: r.source,
          version: r.version,
          gitTag: r.gitTag,
          commitSha: r.commitSha,
          contentHash: r.contentHash,
          filesHash: r.filesHash,
          fileCount: planned.fileCount,
          byteCount: planned.byteCount,
          binaryFiles: planned.binary.length,
          leftOut: release.leftOut,
          yankedAccepted: release.manifest.yanked === true,
          branchRule: inspection.rules.pullRequest ? "rule" : "override",
          previewChecklistAt: state.previewChecklist?.at ?? null,
        },
      });
      return {
        ok: true,
        message:
          `Opened pull request #${opened.number} on ${repository}. Its checks run there. Merging it is the deploy` +
          `${kind === "app" ? ", and the app arrives inactive" : ""}.`,
        links: [{ label: `Pull request #${opened.number}`, href: opened.url }],
        pullRequest: { number: opened.number, url: opened.url, branch: target.branch, head: opened.head },
      };
    });
  } catch (err) {
    const outcome = describe(err);
    await rejected(actor, kind, slug, version, outcome, err instanceof ProposalRefusal ? err.details : {});
    return outcome;
  }
}

async function rejected(
  actor: AdminActor,
  kind: ExtensionKind,
  slug: string,
  version: string | undefined,
  outcome: Extract<ProposeOutcome, { ok: false }>,
  details: Record<string, unknown>,
): Promise<void> {
  let source: string | null = null;
  try {
    source = repositoryBaseUrl();
  } catch {
    // Said in the message already.
  }
  await recordAdminAction(actor, {
    action: `${kind}.propose.rejected`,
    targetType: kind,
    targetId: slug,
    details: {
      reason: outcome.code,
      message: outcome.message,
      version: version ?? "latest",
      source,
      ...details,
    },
  });
}

/** Any failure as what to tell the admin. */
function describe(err: unknown): Extract<ProposeOutcome, { ok: false }> {
  if (err instanceof ProposalRefusal) return err.outcome;
  if (err instanceof GitHubLinkError) return err.outcome;
  if (err instanceof LockUnavailableError) {
    return refused("busy", "Another administrator is proposing, or changing the GitHub link. Try again in a moment.", "neutral");
  }
  if (err instanceof LockLostError) {
    return refused(
      "lock-lost",
      "The proposal was paused for longer than its lock lasts, so it stopped before pushing anything more. " +
        "Look on GitHub for a branch under mixos/ it may have left, then try again.",
      "danger",
    );
  }
  if (err instanceof ContentHashMismatch) {
    return refused(
      "checksum",
      "The package downloaded from GitHub isn't the package the catalogue published a checksum for, so nothing " +
        "was proposed. Either the release changed after it was published, or the download was altered.",
      "danger",
    );
  }
  if (err instanceof InstallError) {
    const message = err.detail ? `${err.message} ${shownText(err.detail, 600)}` : err.message;
    return refused(err.code, message, err.code === "yanked" || err.code === "incompatible" ? "warning" : "danger");
  }
  if (err instanceof SourceFetchError) return refused("download", err.message);
  if (err instanceof ArchiveError) return refused("invalid-package", err.message, "danger");
  if (err instanceof RepositoryError) return refused(err.failure, err.message);
  return fromError(err);
}
