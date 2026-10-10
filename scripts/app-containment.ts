/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What app code may not touch, read off the syntax tree.
 *
 * Apps run in the platform's own server process, with no sandbox. What that
 * arrangement depends on keeping out of an app's hands is checked here, for
 * every app, on every build and every Registry install:
 *
 *  - THE PROCESS ENVIRONMENT. `process.env` holds DATABASE_URL (every table,
 *    as their owner) and CONNECTOR_ENCRYPTION_KEY (every stored credential).
 *    An app reads its configuration as `context.env`.
 *  - THE NETWORK. A raw `fetch` is the SSRF and exfiltration path that
 *    `context.http` exists to close: it checks the manifest's `egress`, resolves
 *    the host and re-checks every address. A fixed upstream is a connector.
 *  - THE PAGE'S MARKUP. HTML the app did not author is an XSS sink. Markdown
 *    renders through `<Markdown>` from @/components/ui/markdown.
 *  - THE PLATFORM'S OWN MODULES. App code imports its own files, a published
 *    list of platform modules and a few packages, and nothing else. That rule,
 *    and what app code may do with what it imports, is src/lib/apps/
 *    import-policy.mjs, which this scan runs on every file.
 *
 * Plus the obvious ways round all of it: running a string as code, naming a
 * global with a string built at runtime, and code the scan never reads.
 *
 * WHY HERE AND NOT ONLY IN LINT. ESLint carries the same bans, as feedback in
 * an editor, but lint runs on pull requests to this repository and nowhere
 * else. The generator runs on every build and as step 9 of every Registry
 * install, so this is the copy that also covers code nobody here reviewed.
 *
 * HOW A GLOBAL IS TOLD APART FROM A LOCAL. Each app is compiled as a small
 * program with no standard library and no module resolution. A reference to a
 * real global — `process`, `fetch` — then resolves to no symbol at all, while a
 * local variable, parameter or import of the same name resolves to its
 * declaration. So an approvals app's own `const process = …` is left alone, and
 * `ctx.http.fetch(…)` is a property access, not the global. A declaration the
 * compiler erases (`declare const process`, a type-only import) is not a local:
 * the running code still reaches the global.
 *
 * NOT A SANDBOX. This reads syntax. Code determined to evade it can still
 * assemble a name at runtime or reach the same object through another module.
 * What it does is make accidental and naive use impossible to ship, and make
 * evasion conspicuous in review. See docs/plans/20261005_2150-app-escapes.md
 * and docs/plans/20261007_0153-app-import-allowlist.md.
 */
import fs from "fs";
import path from "path";
import * as ts from "typescript";
import {
  SCAN_OPTIONS,
  accessedName,
  checkAppSource,
  inTypePosition,
  isGlobalObject,
  isGlobalReference,
  isReference,
  isScannedFile,
  unwrap,
} from "../src/lib/apps/import-policy.mjs";

export interface ContainmentFinding {
  /** Path relative to the app directory, with forward slashes. */
  file: string;
  /** 1-based; 0 for a finding about the file itself rather than a line in it. */
  line: number;
  /** The construct, as written: `process.env`, `fetch`, `dangerouslySetInnerHTML`. */
  what: string;
  /** Why it is refused, and what to use instead. */
  why: string;
}

const WHY = {
  env:
    "reads the process environment, which holds the platform's own secrets. Declare what the app needs under `env` in app.json and read it as context.env.<KEY>.",
  network:
    "reaches the network directly, past the manifest's `egress`. Use context.http, or a connector for a fixed upstream.",
  html:
    "renders markup the app did not author. Render Markdown with <Markdown> from @/components/ui/markdown.",
  code: "runs a string as code.",
  computed:
    "indexes the global object with a name built at runtime, which is how every rule above would otherwise be routed around.",
  symlink:
    "is a symbolic link, which can point anywhere, so the build cannot tell what it loads. Put the file itself in the app.",
  nodeModules:
    "holds packages the build never read, and one here would replace the instance's own copy for this app. An app uses the packages MixOS provides.",
  packageJson:
    "changes how the app's imports resolve. An app has no packages of its own: it uses the ones MixOS provides.",
} as const;

/**
 * Globals that are refused wherever they are referenced. The module loaders,
 * `require` and `module` among them, are import-policy.mjs's to refuse.
 *
 * Maps, not object literals: looking a name up in `{}` finds `toString` and
 * `constructor` on its prototype, which would report every app that mentions
 * them.
 */
const RESTRICTED_GLOBALS = new Map<string, keyof typeof WHY>([
  ["process", "env"],
  ["fetch", "network"],
  ["WebSocket", "network"],
  ["EventSource", "network"],
  ["XMLHttpRequest", "network"],
  ["eval", "code"],
  ["Function", "code"],
]);

/**
 * Every source file the scan reads, and what in the tree it refuses outright.
 *
 * Dot-directories are never entered, and code in one, or in the root
 * directories that hold no code (assets/, plans/, migrations/, screenshots/),
 * is not read; import-policy.mjs refuses any import that lands there. What it
 * cannot judge at all is refused wherever it is: a symbolic link, which can
 * point outside the app; `node_modules/`, which shadows the instance's own
 * packages; and `package.json`, which changes how imports resolve.
 */
function walkApp(appDir: string): { files: string[]; findings: ContainmentFinding[] } {
  const files: string[] = [];
  const findings: ContainmentFinding[] = [];
  const refuse = (full: string, why: string) =>
    findings.push({ file: path.relative(appDir, full).split(path.sep).join("/"), line: 0, what: "", why });

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        refuse(full, WHY.symlink);
      } else if (entry.isDirectory()) {
        if (entry.name === "node_modules") refuse(full, WHY.nodeModules);
        else visit(full);
      } else if (entry.isFile()) {
        if (entry.name === "package.json") refuse(full, WHY.packageJson);
        else if (isScannedFile(appDir, full)) files.push(full);
      }
    }
  };
  visit(appDir);
  return { files, findings };
}

/**
 * Scans every source file under `appDir` and returns what it found, empty when
 * the app is clean. The directory's name is the app's slug. Never throws for
 * the app's sake; a file that does not parse is the build's problem to report,
 * not this scan's.
 */
export function scanAppContainment(appDirPath: string): ContainmentFinding[] {
  const appDir = fs.realpathSync(appDirPath);
  const walk = walkApp(appDir);
  const found: (ContainmentFinding & { column: number })[] = walk.findings.map((f) => ({ ...f, column: 0 }));
  const program = ts.createProgram(walk.files, SCAN_OPTIONS);
  const checker = program.getTypeChecker();

  for (const file of walk.files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const rel = path.relative(appDir, file).split(path.sep).join("/");

    const report = (node: ts.Node, what: string, why: keyof typeof WHY) => {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ file: rel, line: line + 1, column: character, what, why: WHY[why] });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        // el.insertAdjacentHTML(…), document.write(…)
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const name = accessedName(callee);
          if (name === "insertAdjacentHTML") report(node, name, "html");
          const holder = unwrap(callee.expression);
          if (
            (name === "write" || name === "writeln") &&
            ts.isIdentifier(holder) &&
            holder.text === "document" &&
            isGlobalReference(checker, holder)
          ) {
            report(node, `document.${name}`, "html");
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        // el.innerHTML = …
        const name = accessedName(node.left);
        if (name === "innerHTML" || name === "outerHTML") report(node, name, "html");
      } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "dangerouslySetInnerHTML") {
        report(node, "dangerouslySetInnerHTML", "html");
      } else if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === "dangerouslySetInnerHTML"
      ) {
        // createElement("div", { dangerouslySetInnerHTML }) and JSX spreads.
        report(node, "dangerouslySetInnerHTML", "html");
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        // globalThis.fetch, window["process"], and globalThis[computed]
        if (isGlobalObject(checker, node.expression)) {
          const name = accessedName(node);
          const holder = unwrap(node.expression).getText(source);
          if (name === undefined) {
            report(node, `${holder}[…]`, "computed");
          } else {
            const why = RESTRICTED_GLOBALS.get(name);
            if (why) report(node, `${holder}.${name}`, why);
          }
        }
      } else if (
        ts.isIdentifier(node) &&
        RESTRICTED_GLOBALS.has(node.text) &&
        !inTypePosition(node) &&
        isReference(node) &&
        isGlobalReference(checker, node)
      ) {
        // The bare global: process, fetch, eval, Function, WebSocket…
        const parent = node.parent;
        const member =
          node.text === "process" && ts.isPropertyAccessExpression(parent) && parent.expression === node
            ? `process.${parent.name.text}`
            : node.text;
        report(node, member, RESTRICTED_GLOBALS.get(node.text)!);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    for (const f of checkAppSource({ source, checker, appDir })) found.push({ file: rel, ...f });
  }

  return found
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column))
    .map(({ file, line, what, why }) => ({ file, line, what, why }));
}

/** One line per finding, for a `Skipping <slug>/ — …` message. */
export function formatFindings(findings: ContainmentFinding[]): string {
  return findings
    .map((f) => `\n      ${f.file}${f.line > 0 ? `:${f.line}` : ""} — ${f.what ? `${f.what} ${f.why}` : f.why}`)
    .join("");
}
