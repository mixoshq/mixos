/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import * as ts from "typescript";
import type { AppManifest, HookListen } from "../src/lib/apps/types";
import { hookOwner, qualifyHookName } from "../src/lib/hooks/scope";
import { FatalManifestError } from "./manifest-errors";

/**
 * The registry generator's hook checks: what an app's source fires and listens
 * to, held to the namespace rules in `src/lib/hooks/scope.ts` and to the
 * two-sided consent its manifest declares.
 *
 * Its own module so it can be tested against fixture directories. The
 * generator runs on import, so nothing inside it can be.
 */

/** Where a hook call with a literal name appears. */
export interface HookCall {
  /** `fire` for doAction/applyFilters, `listen` for addAction/addFilter. */
  kind: "fire" | "listen";
  /** Stored name: slug-qualified, or core, as the registrar would resolve it. */
  name: string;
  /** Path relative to the app directory, with forward slashes. */
  file: string;
  line: number;
}

export interface HookScan {
  // Emitted-hook counts, including dynamic (non-literal) calls: the registry's
  // `hookCounts`.
  counts: { actions: number; filters: number };
  // String-literal hook names this app fires / listens for, slug-qualified.
  emits: { actions: string[]; filters: string[] };
  listens: { actions: string[]; filters: string[] };
  calls: HookCall[];
}

const HOOK_METHODS = new Set(["doAction", "applyFilters", "addAction", "addFilter"]);

/** The files scanned, and how each parses. */
const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

/**
 * Every `.doAction(`, `.applyFilters(`, `.addAction(` and `.addFilter(` call in
 * an app's source, read off the syntax tree, so a call in a comment or a string
 * is not one. A first argument that is a string literal is a name the build can
 * check. One built at runtime is counted but not named: the registrar checks
 * that one when it is used.
 */
export function scanHooks(appDir: string, slug: string): HookScan {
  let actionCount = 0;
  let filterCount = 0;
  const emitActions = new Set<string>();
  const emitFilters = new Set<string>();
  const listenActions = new Set<string>();
  const listenFilters = new Set<string>();
  const calls: HookCall[] = [];

  function visit(node: ts.Node, source: ts.SourceFile, file: string) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HOOK_METHODS.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      if (method === "doAction") actionCount++;
      if (method === "applyFilters") filterCount++;

      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        const name = qualifyHookName(arg.text, slug);
        const into =
          method === "doAction"
            ? emitActions
            : method === "applyFilters"
              ? emitFilters
              : method === "addAction"
                ? listenActions
                : listenFilters;
        into.add(name);
        calls.push({
          kind: method === "doAction" || method === "applyFilters" ? "fire" : "listen",
          name,
          file,
          line: source.getLineAndCharacterOfPosition(arg.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, source, file));
  }

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SCRIPT_KINDS.has(path.extname(entry.name))) {
        const source = ts.createSourceFile(
          full,
          fs.readFileSync(full, "utf-8"),
          ts.ScriptTarget.Latest,
          true,
          SCRIPT_KINDS.get(path.extname(entry.name)),
        );
        const rel = path.relative(appDir, full).split(path.sep).join("/");
        visit(source, source, rel);
      }
    }
  }
  walk(appDir);

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    counts: { actions: actionCount, filters: filterCount },
    emits: { actions: sorted(emitActions), filters: sorted(emitFilters) },
    listens: { actions: sorted(listenActions), filters: sorted(listenFilters) },
    calls,
  };
}

/** A literal hook call that breaks the rules in `src/lib/hooks/scope.ts`. */
export interface HookFinding {
  /** Path relative to the app directory, with forward slashes. */
  file: string;
  line: number;
  /** What the call does, and what to do instead. */
  why: string;
}

/**
 * Hold an app's literal hook calls to its own namespace and its `listensTo`.
 *
 * - Firing another app's hook. Only the app a hook belongs to can say its
 *   event happened.
 * - Listening to another app's hook without declaring it under `listensTo`.
 *   `validateHookWiring` then requires the emitter to allow each declaration,
 *   so both halves of the consent are checked.
 *
 * Returns what it finds rather than throwing. The generator skips an app with
 * a finding, as it skips one the containment scan refuses: the app is left
 * out of the registry, every other app still builds, and a Registry install of
 * it is rejected. Core hooks, and the app's own, need no declaration either way.
 */
export function checkHookNamespaces(
  slug: string,
  calls: readonly HookCall[],
  listensTo: readonly HookListen[],
): HookFinding[] {
  const findings: HookFinding[] = [];
  for (const call of calls) {
    const owner = hookOwner(call.name);
    if (owner === null || owner === slug) continue;
    const hook = call.name.slice(owner.length + 1);

    if (call.kind === "fire") {
      findings.push({
        file: call.file,
        line: call.line,
        why:
          `fires "${call.name}", a hook of "${owner}". An app fires its own ` +
          `hooks and core hooks; another app's hook is that app's to fire.`,
      });
    } else if (!listensTo.some((d) => d.app === owner && d.hook === hook)) {
      findings.push({
        file: call.file,
        line: call.line,
        why:
          `listens to "${call.name}", a hook of "${owner}", without declaring it. ` +
          `Add { "app": "${owner}", "hook": "${hook}" } to \`listensTo\` in app.json; ` +
          `"${owner}" must also list "${slug}" in that hook's \`consumers\` under \`emits\`.`,
      });
    }
  }
  return findings;
}

/** One line per finding, for a `Skipping <slug>/ — …` message. */
export function formatHookFindings(findings: readonly HookFinding[]): string {
  return findings.map((f) => `\n      ${f.file}:${f.line} — ${f.why}`).join("");
}

/**
 * Two-sided consent for cross-app hooks, mirroring `validateServiceWiring`.
 *
 * A listener must declare what it listens for, and the emitter must allow that
 * listener. A declaration the emitter does not allow is a build failure — the
 * same default-deny App Services has had all along, applied to the one channel
 * that never had it. Code that listens without declaring is for
 * `checkHookNamespaces` to find, and skips its own app rather than the build.
 */
export function validateHookWiring(
  manifests: readonly Pick<AppManifest, "slug" | "emits" | "listensTo">[],
): void {
  const bySlug = new Map(manifests.map((m) => [m.slug, m]));

  for (const consumer of manifests) {
    for (const dep of consumer.listensTo ?? []) {
      const provider = bySlug.get(dep.app);
      if (!provider) {
        throw new FatalManifestError(
          `apps/${consumer.slug}/app.json: listensTo names app "${dep.app}", which does not exist.`,
        );
      }
      const emit = (provider.emits ?? []).find((e) => e.name === dep.hook);
      if (!emit) {
        throw new FatalManifestError(
          `apps/${consumer.slug}/app.json: listensTo "${dep.app}:${dep.hook}", but "${dep.app}" does not declare that hook under \`emits\`.`,
        );
      }
      const allowed =
        emit.consumers === "*" || emit.consumers.includes(consumer.slug);
      if (!allowed) {
        throw new FatalManifestError(
          `apps/${dep.app} does not allow "${consumer.slug}" to listen to "${dep.hook}". ` +
            `Add it to that hook's \`consumers\`, or use "*".`,
        );
      }
    }
  }
}
