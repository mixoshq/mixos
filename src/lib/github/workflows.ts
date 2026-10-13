/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a proposal's code would run before anyone merges it, read from the
 * repository's own files: its workflows, `render.yaml`, and on Vercel,
 * `vercel.json`. A proposal is refused, naming the file, when any of them
 * would run the proposed code with a secret or a token that can write
 * (./propose.ts reads the files; this judges them).
 *
 * A pull request from a branch in the same repository, which is what the App
 * opens, gets the repository's secrets, unlike one from a fork. So:
 *
 *   - `pull_request_target` is refused wherever it appears: it runs with the
 *     secrets and a write token by design.
 *   - A workflow that runs for the App's pull requests or branches, and uses a
 *     secret other than `GITHUB_TOKEN`, asks for a write permission, or sets no
 *     `permissions` (so its token is the repository's default, which can be
 *     read and write), is refused, unless every job in it is skipped for App
 *     branches with `if: ${{ !startsWith(github.head_ref, 'mixos/') }}`. That
 *     condition works only for pull request events: on a push, `head_ref` is
 *     empty and the job runs.
 *   - So is one that runs on a self-hosted runner, which keeps whatever the
 *     machine can reach.
 *   - `render.yaml` that turns previews on is refused: a preview copies the
 *     base service's environment.
 *   - On Vercel, `vercel.json` has to turn off deployments of `mixos/**`, or
 *     every branch the App pushes gets a Preview deployment with the Preview
 *     environment's variables.
 *
 * WHAT RUNS FOR THE APP'S BRANCHES. `pull_request` into the default branch, by
 * its target (`branches` and `branches-ignore` filter the base, so neither can
 * leave the App's pull requests out); `pull_request_review` and
 * `pull_request_review_comment`, which run on the pull request's code when
 * someone reviews it; `merge_group` into the default branch; `push` to the
 * branch about to be pushed; `create`, on any new branch; and `workflow_run`,
 * which runs with secrets after a workflow on that branch, unless its
 * `branches` filter leaves the branch out. Filters are read as GitHub reads
 * them, and a pattern this can't read counts as matching.
 *
 * WHEN IN DOUBT, REFUSE. YAML the check can't read the way GitHub does
 * (duplicate keys, tags, merge keys, more than one document, an alias bomb) is
 * refused, not guessed at, and so are permissions it can't read.
 */

import { parseDocument } from "yaml";

/** One reason to refuse, naming the file. */
export interface Finding {
  file: string;
  problem: string;
}

/** The job condition that keeps a job off the App's pull requests. */
export const APP_BRANCH_CONDITION = "${{ !startsWith(github.head_ref, 'mixos/') }}";

/** What to do about a workflow's findings. Code in backticks, which the pages show as code. */
export const WORKFLOW_FIX =
  `Skip each of its jobs for the App's pull requests with \`if: ${APP_BRANCH_CONDITION}\`, ` +
  "or take out its secrets and write permissions.";

/** What to do about render.yaml's. */
export const RENDER_FIX =
  "Set `previews: { generation: off }` in render.yaml. A preview copies the service's environment.";

/** Where the branch and the target are, for the filters. */
export interface WorkflowContext {
  /** The repository's default branch: what the App's pull requests target. */
  defaultBranch: string;
  /** The branch the App is about to push. */
  branch: string;
}

/* -------------------------------------------------------------------------- */
/*  Reading YAML                                                                */
/* -------------------------------------------------------------------------- */

export class UnreadableYaml extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnreadableYaml";
  }
}

/** A parsed mapping: keys are strings, and the prototype is null. */
type YamlMap = { [key: string]: unknown };

const isMap = (value: unknown): value is YamlMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reason, printable and short: the parser's own words can quote the file. */
function reasonOf(code: string): string {
  return code.replace(/[^A-Z_]/g, "").toLowerCase().replace(/_/g, " ") || "it isn't valid YAML";
}

/**
 * Parse YAML the way this check can trust: one document, YAML 1.2's core
 * schema (so `on` is a string, not a boolean), unique keys, no tags, no merge
 * keys (GitHub's parser doesn't merge them), no key that isn't a string, and
 * at most 100 aliases. Anything else throws UnreadableYaml.
 */
export function readYaml(text: string): unknown {
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  if (doc.errors.length > 0) throw new UnreadableYaml(reasonOf(doc.errors[0].code));
  if (doc.warnings.length > 0) throw new UnreadableYaml(reasonOf(doc.warnings[0].code));
  let js: unknown;
  try {
    js = doc.toJS({ maxAliasCount: 100, mapAsMap: true });
  } catch {
    throw new UnreadableYaml("it has more aliases than this check reads");
  }
  return plain(js, 0);
}

function plain(value: unknown, depth: number): unknown {
  if (depth > 64) throw new UnreadableYaml("it nests deeper than this check reads");
  if (value instanceof Map) {
    const out: YamlMap = Object.create(null) as YamlMap;
    for (const [key, item] of value) {
      if (typeof key !== "string") throw new UnreadableYaml("it has a key that isn't a string");
      if (key === "<<") throw new UnreadableYaml("it uses a merge key, which GitHub doesn't read");
      out[key] = plain(item, depth + 1);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new UnreadableYaml("it has a value this check doesn't read");
}

/* -------------------------------------------------------------------------- */
/*  GitHub's filter patterns                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a branch filter pattern matches `name`, as GitHub's cheat sheet
 * defines them: `*` anything but `/`, `**` anything, `?` and `+` the previous
 * character zero-or-one and one-or-more times, `[…]` one of a-z, A-Z and 0-9
 * and their ranges, `\` escaping the next character. Null when the pattern
 * can't be read, for the caller to take the cautious answer.
 */
export function filterMatches(pattern: string, name: string): boolean | null {
  let source = "^";
  let atoms = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else source += "[^/]*";
      atoms++;
    } else if (c === "?" || c === "+") {
      // A quantifier needs a single character before it.
      if (atoms === 0 || /[*?+]$/.test(source)) return null;
      source += c;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      const inside = end < 0 ? "" : pattern.slice(i + 1, end);
      if (!/^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/.test(inside)) return null;
      source += `[${inside}]`;
      i = end;
      atoms++;
    } else if (c === "\\") {
      if (i + 1 >= pattern.length) return null;
      source += escapeRegExp(pattern[i + 1]);
      i++;
      atoms++;
    } else {
      source += escapeRegExp(c);
      atoms++;
    }
  }
  try {
    return new RegExp(`${source}$`).test(name);
  } catch {
    return null;
  }
}

function escapeRegExp(c: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(c) ? `\\${c}` : c;
}

/** A filter list's patterns, or null when it isn't a list of strings. */
function patterns(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) return value as string[];
  return null;
}

/**
 * Whether `name` passes an include list, read in order: a pattern includes, a
 * `!pattern` after it excludes again. A pattern this can't read includes, and
 * an exclusion it can't read excludes nothing.
 */
function included(list: string[], name: string): boolean {
  let inside = false;
  for (const p of list) {
    if (p.startsWith("!")) {
      if (filterMatches(p.slice(1), name) === true) inside = false;
    } else if (filterMatches(p, name) !== false) inside = true;
  }
  return inside;
}

/**
 * Whether `name` is left out by an ignore list, read the same way. A pattern
 * this can't read leaves nothing out, and a `!pattern` it can't read puts the
 * name back.
 */
function ignored(list: string[], name: string): boolean {
  let out = false;
  for (const p of list) {
    if (p.startsWith("!")) {
      if (filterMatches(p.slice(1), name) !== false) out = false;
    } else if (filterMatches(p, name) === true) out = true;
  }
  return out;
}

/**
 * Whether an event's branch filter lets `name` through: its `branches`, or its
 * `branches-ignore`. No filter, or one that can't be read, lets it through.
 */
function branchFilterRuns(config: unknown, name: string): boolean {
  if (!isMap(config)) return true;
  const only = config.branches === undefined ? null : patterns(config.branches);
  const ignore = config["branches-ignore"] === undefined ? null : patterns(config["branches-ignore"]);
  if (config.branches !== undefined && config["branches-ignore"] !== undefined) return true;
  // An empty list isn't read as "none": GitHub may read it as no filter.
  if (config.branches !== undefined) return only === null || only.length === 0 || included(only, name);
  if (config["branches-ignore"] !== undefined) return ignore === null || !ignored(ignore, name);
  return true;
}

/** Whether a `push` trigger runs for a push to the branch `name`. */
function pushRuns(config: unknown, name: string): boolean {
  if (!isMap(config)) return true;
  const branchFilter = config.branches !== undefined || config["branches-ignore"] !== undefined;
  const tagFilter = config.tags !== undefined || config["tags-ignore"] !== undefined;
  // A push filtered by tags alone doesn't run for branches.
  if (!branchFilter && tagFilter) return false;
  return branchFilterRuns(config, name);
}

/* -------------------------------------------------------------------------- */
/*  Triggers                                                                    */
/* -------------------------------------------------------------------------- */

/** `on:` as event → its configuration (null when it has none), or null when it can't be read. */
function triggersOf(on: unknown): Map<string, unknown> | null {
  if (typeof on === "string") return new Map([[on, null]]);
  if (Array.isArray(on)) {
    if (!on.every((e) => typeof e === "string")) return null;
    return new Map((on as string[]).map((e) => [e, null]));
  }
  if (isMap(on)) return new Map(Object.entries(on));
  return null;
}

/** The events that would run a workflow for the App's branch, and whether all are pull request events. */
function reaching(triggers: Map<string, unknown>, where: WorkflowContext): { events: string[]; pullRequestOnly: boolean } {
  const events: string[] = [];
  let pullRequestOnly = true;
  for (const [event, config] of triggers) {
    switch (event) {
      case "pull_request":
        if (branchFilterRuns(config, where.defaultBranch)) events.push(event);
        break;
      case "pull_request_review":
      case "pull_request_review_comment":
        events.push(event);
        break;
      case "merge_group":
        if (branchFilterRuns(config, where.defaultBranch)) {
          events.push(event);
          pullRequestOnly = false;
        }
        break;
      case "push":
        if (pushRuns(config, where.branch)) {
          events.push(event);
          pullRequestOnly = false;
        }
        break;
      case "create":
        events.push(event);
        pullRequestOnly = false;
        break;
      case "workflow_run":
        if (branchFilterRuns(config, where.branch)) {
          events.push(event);
          pullRequestOnly = false;
        }
        break;
    }
  }
  return { events, pullRequestOnly };
}

/** How a finding says when the workflow runs. */
function whenItRuns(events: string[], where: WorkflowContext): string {
  const parts = new Set<string>();
  for (const e of events) {
    if (e === "pull_request" || e === "merge_group") parts.add(`for pull requests into ${where.defaultBranch}`);
    else if (e === "pull_request_review" || e === "pull_request_review_comment") parts.add("when a pull request is reviewed");
    else if (e === "push") parts.add(`on a push to ${where.branch}`);
    else if (e === "create") parts.add("when a branch is created");
    else if (e === "workflow_run") parts.add(`after a workflow runs on ${where.branch}`);
  }
  return `runs ${[...parts].join(" and ")}`;
}

/* -------------------------------------------------------------------------- */
/*  The job condition                                                           */
/* -------------------------------------------------------------------------- */

const SKIP_CLAUSE = /^!\s*startsWith\s*\(\s*github\s*\.\s*head_ref\s*,\s*'mixos\/'\s*\)$/;

/**
 * An expression's operands joined by `&&` at its top level, or [] when it has
 * a `||` there or its brackets or quotes don't balance.
 */
function topLevelAnd(expression: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quoted) {
      if (c === "'") {
        if (expression[i + 1] === "'") i++;
        else quoted = false;
      }
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return [];
    } else if (depth === 0 && expression.startsWith("||", i)) return [];
    else if (depth === 0 && expression.startsWith("&&", i)) {
      out.push(expression.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  if (quoted || depth !== 0) return [];
  out.push(expression.slice(start));
  return out.map((o) => o.trim());
}

/**
 * Whether a job's `if:` keeps it off the App's pull requests: the condition
 * APP_BRANCH_CONDITION, alone or joined to others by `&&`. With or without
 * `${{ }}` around the whole of it, but not mixed with text outside one, which
 * GitHub reads as a string, and so as true.
 */
export function skipsAppBranches(condition: unknown): boolean {
  if (typeof condition !== "string") return false;
  let expression = condition.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(expression);
  if (wrapped) expression = wrapped[1].trim();
  if (expression.includes("${{") || expression.includes("}}")) return false;
  return topLevelAnd(expression).some((operand) => SKIP_CLAUSE.test(operand));
}

/* -------------------------------------------------------------------------- */
/*  Secrets, permissions, runners                                               */
/* -------------------------------------------------------------------------- */

/** Every `${{ }}` in a string, and the whole of an `if:`, which is an expression without one. */
function expressionsIn(value: string, isCondition: boolean): string[] {
  const out = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
  if (isCondition) out.push(value);
  return out;
}

/**
 * The secrets a workflow reads, by name, `GITHUB_TOKEN` aside: `secrets.NAME`,
 * `secrets['NAME']`, any other use of the `secrets` context, which could read
 * any of them, and `secrets: inherit`, which hands all of them to a called
 * workflow.
 */
function secretsUsed(root: YamlMap): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      for (const expression of expressionsIn(value, key === "if")) {
        const pattern = /(?<![\w.-])secrets(?![\w-])\s*(?:\.\s*([A-Za-z_][\w-]*)|\[\s*'([^']*)'\s*\])?/gi;
        for (const m of expression.matchAll(pattern)) {
          const name = m[1] ?? m[2];
          if (name === undefined) found.add("any of them");
          else if (name.toUpperCase() !== "GITHUB_TOKEN") found.add(name);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, null);
    } else if (isMap(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === "secrets" && v === "inherit") found.add("all of them, through secrets: inherit");
        visit(v, k);
      }
    }
  };
  visit(root, null);
  return [...found].map((n) => (/^[\w-]{1,100}$/.test(n) || n.includes(" ") ? n : "a secret with an odd name")).sort();
}

type PermissionsRead = { set: false } | { set: true; write: string[]; unreadable: boolean };

/** A `permissions:` value: unset, or what it writes and whether it could be read. */
function readPermissions(value: unknown): PermissionsRead {
  if (value === undefined) return { set: false };
  if (value === "read-all") return { set: true, write: [], unreadable: false };
  if (value === "write-all") return { set: true, write: ["every scope (write-all)"], unreadable: false };
  if (!isMap(value)) return { set: true, write: [], unreadable: true };
  const write: string[] = [];
  let unreadable = false;
  for (const [scope, level] of Object.entries(value)) {
    if (level === "write") write.push(/^[a-z-]{1,40}$/.test(scope) ? `${scope}: write` : "a scope to write");
    else if (level !== "read" && level !== "none") unreadable = true;
  }
  return { set: true, write, unreadable };
}

/** Whether a job runs on a self-hosted runner: its `runs-on` or its matrix names one. */
function selfHosted(job: YamlMap): boolean {
  const words: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (isMap(value)) Object.values(value).forEach(collect);
  };
  collect(job["runs-on"]);
  const runsOn = job["runs-on"];
  if (typeof runsOn === "string" && runsOn.includes("${{")) collect(job.strategy);
  return words.some((w) => /self-hosted/i.test(w));
}

/* -------------------------------------------------------------------------- */
/*  The checks                                                                  */
/* -------------------------------------------------------------------------- */

const list = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** A workflow file's findings: [] when it is fine for the App's branch. `file` is its path in the repository. */
export function checkWorkflow(file: string, text: string, where: WorkflowContext): Finding[] {
  let root: unknown;
  try {
    root = readYaml(text);
  } catch (err) {
    const why = err instanceof UnreadableYaml ? err.message : "it isn't valid YAML";
    return [{ file, problem: `can't be read the way GitHub reads it (${why}), so the check can't tell what it runs.` }];
  }
  if (!isMap(root)) return [{ file, problem: "isn't a workflow the check can read." }];
  const triggers = triggersOf(root.on);
  if (!triggers) return [{ file, problem: "has an `on:` the check can't read." }];

  const findings: Finding[] = [];
  if (triggers.has("pull_request_target")) {
    findings.push({
      file,
      problem: "uses pull_request_target, which runs with this repository's secrets and a write token.",
    });
  }

  const reach = reaching(triggers, where);
  if (reach.events.length === 0) return findings;

  const jobs = root.jobs;
  if (!isMap(jobs) || Object.keys(jobs).length === 0) {
    findings.push({ file, problem: "has jobs the check can't read." });
    return findings;
  }
  const jobList = Object.values(jobs);
  if (!jobList.every(isMap)) {
    findings.push({ file, problem: "has jobs the check can't read." });
    return findings;
  }
  // Skipped for the App's pull requests, every job: nothing in it runs them.
  if (reach.pullRequestOnly && jobList.every((job) => skipsAppBranches(job.if))) return findings;

  const when = whenItRuns(reach.events, where);
  const secrets = secretsUsed(root);
  if (secrets.length > 0) {
    findings.push({ file, problem: `${when} and uses ${secrets.length === 1 ? "the secret" : "the secrets"} ${list(secrets)}.` });
  }

  const top = readPermissions(root.permissions);
  const write = new Set<string>();
  let unreadable = top.set && top.unreadable;
  let unset = false;
  if (top.set) top.write.forEach((w) => write.add(w));
  for (const job of jobList) {
    const own = readPermissions(job.permissions);
    if (own.set) {
      own.write.forEach((w) => write.add(w));
      if (own.unreadable) unreadable = true;
    } else if (!top.set) unset = true;
  }
  if (write.size > 0) findings.push({ file, problem: `${when} and asks for ${list([...write].sort())}.` });
  if (unset) {
    findings.push({
      file,
      problem: `${when} and sets no permissions, so its token is the repository's default, which can write.`,
    });
  }
  if (unreadable) findings.push({ file, problem: `${when} with permissions the check can't read.` });
  if (jobList.some(selfHosted)) findings.push({ file, problem: `${when} on a self-hosted runner.` });
  return findings;
}

/** What turns a Render preview on: `previews.generation` other than `off`. */
function previewsOn(previews: unknown): "on" | "off" | "unreadable" {
  if (previews === undefined || previews === null) return "off";
  if (!isMap(previews)) return "unreadable";
  const generation = previews.generation;
  if (generation === undefined || generation === "off") return "off";
  if (generation === "manual" || generation === "automatic") return "on";
  return "unreadable";
}

/**
 * `render.yaml`'s findings. Previews are on when the Blueprint's
 * `previews.generation` (preview environments), or a service's (service
 * previews), is `manual` or `automatic`, or a service sets the older
 * `pullRequestPreviewsEnabled`.
 */
export function checkRenderYaml(text: string, file = "render.yaml"): Finding[] {
  let root: unknown;
  try {
    root = readYaml(text);
  } catch (err) {
    const why = err instanceof UnreadableYaml ? err.message : "it isn't valid YAML";
    return [{ file, problem: `can't be read (${why}), so the check can't tell whether it turns previews on.` }];
  }
  if (!isMap(root)) return [{ file, problem: "isn't a Blueprint the check can read." }];
  const findings: Finding[] = [];
  const top = previewsOn(root.previews);
  if (top === "on") findings.push({ file, problem: "turns on preview environments (previews.generation)." });
  if (top === "unreadable") findings.push({ file, problem: "has previews the check can't read." });

  const services = root.services;
  if (services !== undefined && !Array.isArray(services)) {
    findings.push({ file, problem: "has services the check can't read." });
  } else if (Array.isArray(services)) {
    for (const service of services) {
      if (!isMap(service)) {
        findings.push({ file, problem: "has a service the check can't read." });
        continue;
      }
      const name =
        typeof service.name === "string" && /^[\w.-]{1,64}$/.test(service.name) ? service.name : "a service";
      const own = previewsOn(service.previews);
      const legacy = service.pullRequestPreviewsEnabled;
      if (own === "on" || legacy === true || legacy === "yes" || legacy === "true") {
        findings.push({ file, problem: `turns on pull request previews for ${name}.` });
      } else if (own === "unreadable" || (legacy !== undefined && legacy !== false && legacy !== "no" && legacy !== "false")) {
        findings.push({ file, problem: `has previews for ${name} the check can't read.` });
      }
    }
  }
  return findings;
}

/** The `vercel.json` setting that keeps the App's branches from deploying. */
export const VERCEL_SETTING = '"git": { "deploymentEnabled": { "mixos/**": false } }';

/**
 * `vercel.json`'s findings, for an instance on Vercel: `text` is the file, or
 * null when the repository has none. Deployments of the App's branches have to
 * be off: `git.deploymentEnabled` false, or `false` for `mixos/**` (or `**`)
 * with nothing else that could turn them back on.
 */
export function checkVercelJson(text: string | null, branch: string, file = "vercel.json"): Finding[] {
  const fix = `Add \`${VERCEL_SETTING}\` to vercel.json.`;
  if (text === null) {
    return [
      {
        file,
        problem:
          "doesn't exist, so Vercel builds a Preview deployment, with your Preview environment variables, of every " +
          `branch the App pushes. ${fix}`,
      },
    ];
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [{ file, problem: "isn't JSON, so the check can't tell whether Vercel deploys the App's branches." }];
  }
  if (!isMap(root)) return [{ file, problem: "isn't a vercel.json the check can read." }];
  const git = root.git;
  const legacy = root.github;
  if (isMap(legacy) && legacy.enabled === false) return [];
  const enabled = isMap(git) ? git.deploymentEnabled : undefined;
  if (enabled === false) return [];
  if (isMap(enabled)) {
    const off = enabled["mixos/**"] === false || enabled["**"] === false;
    const backOn = Object.entries(enabled).some(
      ([pattern, value]) => value !== false && (/[*?[\]{}!]/.test(pattern) || pattern === branch || pattern.startsWith("mixos/")),
    );
    if (off && !backOn) return [];
  }
  return [
    {
      file,
      problem: `doesn't turn off Vercel's deployments of the App's branches, so each gets a Preview deployment. ${fix}`,
    },
  ];
}
