/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What app code may not touch, read off the syntax tree.
 *
 * Apps run in the platform's own server process, with no sandbox. Three things
 * that arrangement depends on keeping out of an app's hands are checked here,
 * for every app, on every build and every Registry install:
 *
 *  - THE PROCESS ENVIRONMENT. `process.env` holds DATABASE_URL (every table,
 *    as their owner) and CONNECTOR_ENCRYPTION_KEY (every stored credential).
 *    An app reads its configuration as `context.env`.
 *  - THE NETWORK. A raw `fetch` is the SSRF and exfiltration path that
 *    `context.http` exists to close: it checks the manifest's `egress`, resolves
 *    the host and re-checks every address. A fixed upstream is a connector.
 *  - THE PAGE'S MARKUP. HTML the app did not author is an XSS sink. Markdown
 *    renders through `<Markdown>` from @/components/ui/markdown.
 *
 * Plus the obvious ways round all three: running a string as code, and naming a
 * global or a module with a string built at runtime.
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
 * `ctx.http.fetch(…)` is a property access, not the global.
 *
 * NOT A SANDBOX. This reads syntax. Code determined to evade it can still
 * assemble a name at runtime or reach the same object through another module.
 * What it does is make accidental and naive use impossible to ship, and make
 * evasion conspicuous in review. See docs/plans/20261005_2150-app-escapes.md.
 */
import fs from "fs";
import path from "path";
import * as ts from "typescript";

export interface ContainmentFinding {
  /** Path relative to the app directory, with forward slashes. */
  file: string;
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
  computedModule:
    "loads a module whose name is built at runtime, which is how the import rules would otherwise be routed around.",
} as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Directories that hold nothing the app runs. */
const NOT_CODE = new Set(["node_modules", "plans", "screenshots", "migrations", "assets"]);

/** The global object, by every name it goes by. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

/**
 * Globals that are refused wherever they are referenced.
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

/** Modules whose import is refused, with or without a `node:` prefix. */
const RESTRICTED_MODULES = new Map<string, keyof typeof WHY>([
  ["process", "env"],
  ...(["http", "https", "http2", "net", "tls", "dgram"] as const).map(
    (m) => [m, "network"] as const,
  ),
  ...(
    ["undici", "node-fetch", "axios", "got", "ky", "superagent", "cross-fetch", "isomorphic-fetch"] as const
  ).map((m) => [m, "network"] as const),
]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_CODE.has(entry.name)) listSourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function moduleName(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

/** True when `node` sits inside a type, where a name refers to nothing at runtime. */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/** `(x as any)`, `x!`, `<T>x`, `x satisfies T` and `(x)` are all still `x`. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * `./locales/${lang}`: a path built at runtime that still starts inside the
 * app, so it cannot name a built-in or a package.
 */
function isRelativeTemplate(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (!ts.isTemplateExpression(e)) return false;
  const head = e.head.text;
  return (head.startsWith("./") || head.startsWith("../")) && !head.includes("node_modules");
}

/** The property name of `a.b` or `a["b"]`, when it is written literally. */
function accessedName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const arg = node.argumentExpression;
  return ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/**
 * Scans every source file under `appDir` and returns what it found, empty when
 * the app is clean. Never throws for the app's sake; a file that does not parse
 * is the build's problem to report, not this scan's.
 */
export function scanAppContainment(appDir: string): ContainmentFinding[] {
  const files = listSourceFiles(appDir);
  if (files.length === 0) return [];

  const program = ts.createProgram(files, {
    noLib: true,
    noResolve: true,
    types: [],
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const findings: ContainmentFinding[] = [];

  /** Unresolved means global: nothing in the app declares or imports it. */
  const isGlobalReference = (id: ts.Identifier): boolean => {
    if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
      return checker.getShorthandAssignmentValueSymbol(id.parent) === undefined;
    }
    const symbol = checker.getSymbolAtLocation(id);
    return symbol === undefined || !symbol.declarations || symbol.declarations.length === 0;
  };

  const isGlobalObject = (expr: ts.Expression): boolean => {
    const e = unwrap(expr);
    return ts.isIdentifier(e) && GLOBAL_OBJECTS.has(e.text) && isGlobalReference(e);
  };

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const rel = path.relative(appDir, file).split(path.sep).join("/");

    const report = (node: ts.Node, what: string, why: keyof typeof WHY) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file: rel, line: line + 1, what, why: WHY[why] });
    };

    const checkModule = (
      node: ts.Node,
      specifier: ts.Expression | undefined,
      label = (name: string) => `import "${name}"`,
    ) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const why = RESTRICTED_MODULES.get(moduleName(specifier.text));
      if (why) report(node, label(specifier.text), why);
    };

    const visit = (node: ts.Node): void => {
      // import … from "node:https" / export … from "axios"
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        checkModule(node, node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        checkModule(node, node.moduleReference.expression);
      } else if (ts.isCallExpression(node)) {
        // require("https") and import("https"). A name built at runtime is
        // refused outright, unless it is a relative path.
        const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isImport || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
          const call = isImport ? "import" : "require";
          const specifier = node.arguments[0];
          if (specifier && ts.isStringLiteralLike(unwrap(specifier))) {
            checkModule(node, unwrap(specifier), (name) => `${call}("${name}")`);
          } else if (specifier && !isRelativeTemplate(specifier)) {
            report(node, `${call}(…)`, "computedModule");
          }
        }
        // el.insertAdjacentHTML(…), document.write(…)
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const name = accessedName(callee);
          if (name === "insertAdjacentHTML") report(node, name, "html");
          if (
            (name === "write" || name === "writeln") &&
            ts.isIdentifier(unwrap(callee.expression)) &&
            (unwrap(callee.expression) as ts.Identifier).text === "document" &&
            isGlobalReference(unwrap(callee.expression) as ts.Identifier)
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
        if (isGlobalObject(node.expression)) {
          const name = accessedName(node);
          const holder = (unwrap(node.expression) as ts.Identifier).text;
          if (name === undefined) {
            report(node, `${holder}[…]`, "computed");
          } else {
            const why = RESTRICTED_GLOBALS.get(name);
            if (why) report(node, `${holder}.${name}`, why);
          }
        }
      } else if (ts.isIdentifier(node) && RESTRICTED_GLOBALS.has(node.text) && !inTypePosition(node)) {
        // The bare global: process, fetch, eval, Function, WebSocket…
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          ((ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isMethodSignature(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isEnumMember(parent)) &&
            parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node) ||
          ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node) ||
          ts.isJsxAttribute(parent) ||
          ts.isLabeledStatement(parent);
        if (!isPropertyName && isGlobalReference(node)) {
          const member =
            node.text === "process" && ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? `process.${parent.name.text}`
              : node.text;
          report(node, member, RESTRICTED_GLOBALS.get(node.text)!);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return findings;
}

/** One line per finding, for a `Skipping <slug>/ — …` message. */
export function formatFindings(findings: ContainmentFinding[]): string {
  return findings.map((f) => `\n      ${f.file}:${f.line} — ${f.what} ${f.why}`).join("");
}
