/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading each route's `defineRoute` options from its source, without running it.
 *
 * An install's check (`generate-project-registry.ts --check`) runs none of an
 * extension's code, and the build reads a route's contract by importing the
 * route. But most routes write their options out in full:
 *
 *     export const GET = defineRoute({ roles: ["viewer"], output: …, handler });
 *
 * and three of the build's rules need nothing more than that: a method exported
 * as something other than a `defineRoute()` result, a role the app does not
 * declare, and `raw: true` without the raw-response escape. This reads each
 * route's exports off its syntax tree and judges those three with the build's
 * own rules (./route-contracts.ts), so the check refuses what the build would
 * refuse, in the same words.
 *
 * WHAT IT CANNOT READ, IT LEAVES. It never guesses. Options built from a
 * variable, a spread, a call or a computed key; a role that is not a string
 * written out; a method imported or re-exported from another file; an export
 * used anywhere else in its file, where code could change it before the build
 * reads it: each is listed as deferred, with the reason, and the generator
 * checks it at registration, which loads the route.
 *
 * WHAT IT DOES NOT CHECK. The rest of a route's contract needs its code: the
 * schemas, whether a JSON route declares `output`, `auth` against `roles`,
 * and whether the module loads at all. Registration checks
 * all of it, for every route, read here or not.
 *
 * It parses with the TypeScript compiler, one program over an app's route
 * files with no module resolution, as the containment scan does. Nothing it
 * reads is imported or run.
 */

import * as ts from "typescript";
import {
  SCAN_OPTIONS,
  isGlobalReference,
  isReference,
  referencedSymbol,
  resolveImport,
  unwrap,
} from "../src/lib/apps/import-policy.mjs";
import {
  HTTP_METHODS,
  bareHandlerProblem,
  rawResponseRefusal,
  routeFileName,
  undeclaredRoleProblems,
  type HttpMethod,
  type RawMethod,
} from "./route-contracts";

/** The specifier `defineRoute` is imported by; judged by the file it lands on. */
const ROUTE_MODULE = "@/lib/apps/route";

/**
 * Something the reader could not read, as a deferred item says it: `why` is a
 * clause about the route ("GET's options are in a variable"), and `what` names
 * what registration checks instead, with its verb ("its contract is").
 */
interface Unread {
  why: string;
  what: string;
}

/** The whole of a method's contract, or a file's, waits for registration. */
const unreadContract = (why: string): Unread => ({ why, what: "its contract is" });

/** A value read off the source, or why it could not be. */
type Reading<T> = { value: T } | { unread: Unread };

/** One exported HTTP method, as far as its source says. */
type MethodReading =
  | { method: HttpMethod; kind: "bare" }
  | { method: HttpMethod; kind: "route"; roles: Reading<string[]>; raw: Reading<boolean> }
  | { method: HttpMethod; kind: "unread"; unread: Unread };

/** One route file, read. */
interface RouteReading {
  /** Every method it exports that the reader can see, in HTTP_METHODS order. */
  methods: MethodReading[];
  /** What keeps the file, or a method it may export, from being read. */
  unread: Unread[];
}

/** One `route.ts`, as scripts/generate-project-registry.ts finds it. */
export interface RouteSource {
  /** Absolute path. */
  file: string;
  /** POSIX, relative to `api/`; `""` for `api/index/route.ts`. */
  routePath: string;
}

/** What the reader made of an app's routes, in the shape of a verdict. */
export interface StaticRoutes {
  /** Each names its file, in the build's words. */
  problems: string[];
  /** What it could not read, each naming its file and why. */
  deferred: string[];
}

const isMethod = (name: string): name is HttpMethod => (HTTP_METHODS as readonly string[]).includes(name);

/** The text of an export or import name: `GET`, or `"GET"` in `export { x as "GET" }`. */
const nameText = (name: ts.ModuleExportName): string => name.text;

/**
 * An app's routes, judged on the three rules their source decides: a bare
 * handler, an undeclared role, and `raw: true` without its escape. Problems
 * come in the order the build meets them: bare handlers as the routes are
 * found, then roles and raw routes by path. Reads text only.
 *
 * `appDir` is the app's real path, which imports are resolved from, and
 * `manifest` its parsed `app.json`.
 */
export function readRoutesStatically(
  appDir: string,
  slug: string,
  routes: readonly RouteSource[],
  manifest: { roles: readonly { key: string }[]; escapes: readonly { rule: string }[] },
): StaticRoutes {
  if (routes.length === 0) return { problems: [], deferred: [] };

  const program = ts.createProgram(
    routes.map((r) => r.file),
    SCAN_OPTIONS,
  );
  const checker = program.getTypeChecker();
  const readings = new Map<RouteSource, RouteReading>();
  for (const route of routes) {
    const source = program.getSourceFile(route.file);
    readings.set(
      route,
      source
        ? readRoute(source, checker, appDir, program.getSyntacticDiagnostics(source).length > 0)
        : { methods: [], unread: [unreadContract("it could not be read")] },
    );
  }

  const bare: string[] = [];
  const roles: string[] = [];
  const raw: RawMethod[] = [];
  const deferred: string[] = [];
  for (const route of routes) {
    const reading = readings.get(route)!;
    const file = routeFileName(slug, route.routePath);
    const defer = ({ why, what }: Unread) =>
      deferred.push(`${file}: ${why}, so ${what} checked at registration, which loads it.`);
    reading.unread.forEach(defer);
    for (const m of reading.methods) {
      if (m.kind === "bare") bare.push(bareHandlerProblem(slug, route.routePath, m.method));
      else if (m.kind === "unread") defer(m.unread);
      else {
        if ("unread" in m.roles) defer(m.roles.unread);
        if ("unread" in m.raw) defer(m.raw.unread);
      }
    }
  }

  // The build checks roles and raw routes once every route has loaded, in
  // path order (importRouteContracts sorts its contracts).
  const byPath = [...routes].sort((a, b) => a.routePath.localeCompare(b.routePath));
  for (const route of byPath) {
    for (const m of readings.get(route)!.methods) {
      if (m.kind !== "route") continue;
      if ("value" in m.roles) {
        roles.push(...undeclaredRoleProblems(slug, route.routePath, m.method, m.roles.value, manifest.roles));
      }
      if ("value" in m.raw && m.raw.value) raw.push({ routePath: route.routePath, method: m.method });
    }
  }

  return {
    problems: [...bare, ...roles, ...(rawResponseRefusal(slug, raw, manifest.escapes)?.problems ?? [])],
    deferred,
  };
}

/** One route file's exports, read. */
function readRoute(source: ts.SourceFile, checker: ts.TypeChecker, appDir: string, unparsed: boolean): RouteReading {
  if (unparsed) return { methods: [], unread: [unreadContract("it does not parse")] };

  const unread: Unread[] = [];
  const routeModule = (() => {
    const target = resolveImport(ROUTE_MODULE, source.fileName, appDir);
    return target.kind === "file" ? target.file : null;
  })();

  // Every runtime use of each name in the file, by what it names. An exported
  // binding used anywhere else may be changed before the build reads it.
  const uses = new Map<ts.Symbol, ts.Identifier[]>();
  let commonJs = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node) && !inTypeOnlyPosition(node)) {
      if (node.text === "exports" && isGlobalReference(checker, node)) commonJs = true;
      // An export clause hands a binding on as it is; it changes nothing.
      if (!ts.isExportSpecifier(node.parent)) {
        const symbol = normalize(checker, referencedSymbol(checker, node));
        if (symbol) uses.set(symbol, [...(uses.get(symbol) ?? []), node]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // CommonJS can add an export no `export` statement names: `exports.GET = …`
  // in a file with no import or export becomes the module's GET when tsx loads
  // it, and so do the keys of TypeScript's `export = {…}`. `module` and
  // `require` are the containment scan's to refuse.
  if (commonJs) return { methods: [], unread: [unreadContract("it uses CommonJS `exports`")] };
  if (source.statements.some((s) => ts.isExportAssignment(s) && s.isExportEquals)) {
    return { methods: [], unread: [unreadContract("it uses `export =`")] };
  }

  /** Each exported method, and where its value comes from. */
  const exported = new Map<HttpMethod, { symbol: ts.Symbol | undefined; via?: ts.Identifier } | { unread: Unread }>();
  const twice = new Set<HttpMethod>();
  const add = (name: string, how: { symbol: ts.Symbol | undefined; via?: ts.Identifier } | { unread: Unread }) => {
    if (!isMethod(name)) return;
    if (exported.has(name)) twice.add(name);
    exported.set(name, how);
  };
  const elsewhere = (method: string, how: string): { unread: Unread } => ({
    unread: unreadContract(`${method} is ${how}`),
  });

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier) {
        if (!clause) {
          unread.push({ why: "it re-exports everything from another file", what: "any method that file adds is" });
        } else if (ts.isNamespaceExport(clause)) {
          add(nameText(clause.name), elsewhere(nameText(clause.name), "re-exported from another file"));
        } else {
          for (const el of clause.elements) {
            if (!el.isTypeOnly) add(nameText(el.name), elsewhere(nameText(el.name), "re-exported from another file"));
          }
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          const local = el.propertyName ?? el.name;
          add(nameText(el.name), {
            symbol: normalize(checker, checker.getExportSpecifierLocalTargetSymbol(el)),
            via: ts.isIdentifier(local) ? local : undefined,
          });
        }
      }
    } else if (
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      // `export default` names no method; nor does a statement that is not exported.
      // Erased, with no value at runtime: a `declare`, or an overload signature,
      // whose function is the declaration with a body.
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
      if (ts.isFunctionDeclaration(statement) && !statement.body) continue;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            add(decl.name.text, { symbol: normalize(checker, checker.getSymbolAtLocation(decl.name)) });
          } else {
            for (const name of boundNames(decl.name)) add(name, elsewhere(name, "bound by destructuring"));
          }
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        add(statement.name.text, { symbol: normalize(checker, checker.getSymbolAtLocation(statement.name)) });
      } else if (ts.isImportEqualsDeclaration(statement)) {
        add(statement.name.text, elsewhere(statement.name.text, "an alias the check does not read"));
      }
    }
  }

  const methods: MethodReading[] = [];
  for (const method of HTTP_METHODS) {
    const how = exported.get(method);
    if (!how) continue;
    if (twice.has(method)) {
      methods.push({ method, kind: "unread", unread: unreadContract(`${method} is exported more than once`) });
    } else if ("unread" in how) {
      methods.push({ method, kind: "unread", unread: how.unread });
    } else {
      const value = bindingValue(how.symbol, how.via, method, { checker, uses, appDir, source, routeModule }, 0);
      if (value) methods.push({ method, ...value } as MethodReading);
    }
  }
  return { methods, unread };
}

interface Context {
  checker: ts.TypeChecker;
  uses: Map<ts.Symbol, ts.Identifier[]>;
  appDir: string;
  source: ts.SourceFile;
  routeModule: string | null;
}

type Judged =
  | { kind: "bare" }
  | { kind: "route"; roles: Reading<string[]>; raw: Reading<boolean> }
  | { kind: "unread"; unread: Unread };

/** How deep a chain of local names (`export const GET = handler`) is followed. */
const MAX_ALIASES = 8;

/**
 * What an exported binding holds when the build reads it, or null when it holds
 * nothing at runtime (`export let GET;`, never assigned), which the build skips
 * as it skips an export that is `undefined`.
 *
 * `via` is the reference that led here (an export clause's name, or the
 * initializer of another binding), which is not a use of its own.
 */
function bindingValue(
  symbol: ts.Symbol | undefined,
  via: ts.Identifier | undefined,
  method: HttpMethod,
  cx: Context,
  depth: number,
): Judged | null {
  const unread = (why: string): Judged => ({ kind: "unread", unread: unreadContract(`${method} ${why}`) });
  if (!symbol || depth > MAX_ALIASES) return unread("is read from a variable");

  // Not what the compiler erases: `declare const x`, an interface, a type.
  const decls = (symbol.declarations ?? []).filter(
    (d) =>
      !(ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Ambient) &&
      !ts.isInterfaceDeclaration(d) &&
      !ts.isTypeAliasDeclaration(d),
  );
  // An overload signature has no body, and nothing of it runs.
  const runtime = decls.filter((d) => !(ts.isFunctionDeclaration(d) && !d.body));
  if (runtime.length === 0) return decls.length === 0 ? unread("is read from a variable") : null;
  if (runtime.length > 1) return unread("is declared more than once");
  const decl = runtime[0];

  if ((cx.uses.get(symbol) ?? []).some((use) => use !== via)) {
    return unread("is used elsewhere in the file, where code could change it");
  }
  if (isImportBinding(decl)) return unread("is imported from another file");
  // A function or a class: typeof "function", never a defineRoute() result,
  // whatever is done to it.
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return { kind: "bare" };
  if (ts.isVariableDeclaration(decl)) {
    // Declared by a statement of its own at the top of the file, not by a
    // `for` head or a `catch` clause, which assign it as they run.
    const statement = decl.parent.parent;
    if (!ts.isVariableStatement(statement) || statement.parent !== cx.source) {
      return unread("is declared in a way the check does not read");
    }
    if (!ts.isIdentifier(decl.name)) return unread("is bound by destructuring");
    if (!decl.initializer) return null;
    return expressionValue(decl.initializer, method, cx, depth);
  }
  return unread("is not a function or a defineRoute(...) call");
}

/** What `expr`, the initializer of an exported binding, evaluates to, as far as the rules need. */
function expressionValue(expr: ts.Expression, method: HttpMethod, cx: Context, depth: number): Judged {
  const unread = (why: string): Judged => ({ kind: "unread", unread: unreadContract(`${method} ${why}`) });
  const e = unwrap(expr);

  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee) && isDefineRoute(callee, cx)) return readOptions(e, method, cx);
    if (ts.isIdentifier(callee) && callee.text === "defineRoute") {
      return unread(`calls a defineRoute that is not the one from ${ROUTE_MODULE}`);
    }
    return unread("is built by a call to something other than defineRoute");
  }
  // typeof "function", or no object at all: never a defineRoute() result.
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e) || isPrimitiveLiteral(e)) {
    return { kind: "bare" };
  }
  if (ts.isIdentifier(e)) {
    const symbol = normalize(cx.checker, cx.checker.getSymbolAtLocation(e));
    if (symbol && isTopLevel(symbol, cx.source)) {
      const value = bindingValue(symbol, e, method, cx, depth + 1);
      // A name holding nothing holds `undefined`, which the build skips.
      return value ?? unread("is a variable that holds nothing");
    }
    return unread(isImported(e, cx) ? "is imported from another file" : "is read from a variable");
  }
  return unread("is not a function or a defineRoute(...) call");
}

/** `defineRoute({...})`: the options, as far as the two rules on them need. */
function readOptions(call: ts.CallExpression, method: HttpMethod, cx: Context): Judged {
  const whole = (why: string): Judged => ({ kind: "unread", unread: unreadContract(`${method}'s options ${why}`) });
  const [first] = call.arguments;
  if (!first) return { kind: "unread", unread: unreadContract(`${method} calls defineRoute with no options`) };
  if (ts.isSpreadElement(first)) return whole("are passed as a spread");
  const options = unwrap(first);
  if (!ts.isObjectLiteralExpression(options)) {
    return whole(`are ${describe(options, cx, "not an object written out")}`);
  }

  let roles: Reading<string[]> = { value: [] };
  let raw: Reading<boolean> = { value: false };
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) return whole("include a spread");
    if (prop.name && ts.isComputedPropertyName(prop.name)) return whole("have a computed key");
    const key = prop.name ? propertyKey(prop.name) : undefined;
    // `__proto__: x` sets the prototype, which `spec.raw` and `spec.roles`
    // are read through.
    if (key === "__proto__") return whole("set their prototype");
    if (key === "roles") roles = readRoles(prop, method, cx);
    else if (key === "raw") raw = readRaw(prop, method, cx);
  }
  return { kind: "route", roles, raw };
}

/** `roles: ["a", "b"]`: each a string written out. */
function readRoles(prop: ts.ObjectLiteralElementLike, method: HttpMethod, cx: Context): Reading<string[]> {
  const unread = (why: string): Reading<string[]> => ({
    unread: { why: `${method}'s \`roles\` ${why}`, what: "its roles are" },
  });
  const value = propertyValue(prop);
  if (!value) return unread("are a method or an accessor");
  const list = unwrap(value);
  if (!ts.isArrayLiteralExpression(list)) return unread(`are ${describe(list, cx, "not a list written out")}`);
  const out: string[] = [];
  for (const el of list.elements) {
    if (ts.isSpreadElement(el)) return unread("include a spread");
    if (ts.isOmittedExpression(el)) return unread("include an empty slot");
    const entry = unwrap(el);
    if (!ts.isStringLiteralLike(entry)) return unread("include an entry that is not a string written out");
    out.push(entry.text);
  }
  return { value: out };
}

/** `raw: true` or `raw: false`. The build reads `raw === true`. */
function readRaw(prop: ts.ObjectLiteralElementLike, method: HttpMethod, cx: Context): Reading<boolean> {
  const unread = (why: string): Reading<boolean> => ({
    unread: { why: `${method}'s \`raw\` ${why}`, what: "whether it returns its own Response is" },
  });
  const value = propertyValue(prop);
  if (!value) return unread("is a method or an accessor");
  const flag = unwrap(value);
  if (flag.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (flag.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  return unread(`is ${describe(flag, cx, "not `true` or `false`")}`);
}

/** The expression a property sets: `x` for `k: x` and for the shorthand `{ x }`; none for a method or accessor. */
function propertyValue(prop: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  return undefined;
}

/** A key written as a name, a string or a number. */
function propertyKey(name: ts.PropertyName): string | undefined {
  const written = ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name);
  return written || ts.isNumericLiteral(name) ? name.text : undefined;
}

/** How a value the reader will not read is built, for "GET's options are …". */
function describe(e: ts.Expression, cx: Context, otherwise: string): string {
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    let root: ts.Expression = e;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
    return ts.isIdentifier(root) && isImported(root, cx) ? "imported from another file" : "in a variable";
  }
  if (ts.isCallExpression(e) || ts.isNewExpression(e) || ts.isTaggedTemplateExpression(e)) {
    return "built by a function call";
  }
  return otherwise;
}

/** Whether `callee` is `defineRoute` imported from the route contract module, by the file the import lands on. */
function isDefineRoute(callee: ts.Identifier, cx: Context): boolean {
  if (!cx.routeModule) return false;
  const decls = cx.checker.getSymbolAtLocation(callee)?.declarations ?? [];
  if (decls.length !== 1 || !ts.isImportSpecifier(decls[0])) return false;
  const spec = decls[0];
  if (spec.isTypeOnly || spec.parent.parent.isTypeOnly) return false;
  if (nameText(spec.propertyName ?? spec.name) !== "defineRoute") return false;
  const statement = spec.parent.parent.parent;
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
  const target = resolveImport(statement.moduleSpecifier.text, cx.source.fileName, cx.appDir);
  return target.kind === "file" && target.file === cx.routeModule;
}

/** Whether `id` reads an import of this file: `x`, or the `x` of a shorthand `{ x }`. */
function isImported(id: ts.Identifier, cx: Context): boolean {
  return (referencedSymbol(cx.checker, id)?.declarations ?? []).some(isImportBinding);
}

/** A name an import binds, whose value is another file's. */
function isImportBinding(decl: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(decl) ||
    ts.isImportClause(decl) ||
    ts.isNamespaceImport(decl) ||
    ts.isImportEqualsDeclaration(decl)
  );
}

/** Whether `symbol` is declared at the top of `source`, as a module-level binding. */
function isTopLevel(symbol: ts.Symbol, source: ts.SourceFile): boolean {
  return (symbol.declarations ?? []).some((d) => {
    const statement = ts.isVariableDeclaration(d) ? d.parent.parent : d;
    return statement.parent === source;
  });
}

/** A string, number, bigint, regex, template, boolean or `null` written out. */
function isPrimitiveLiteral(e: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    ts.isTemplateExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Every name a destructuring pattern binds. */
function boundNames(pattern: ts.BindingName): string[] {
  if (ts.isIdentifier(pattern)) return [pattern.text];
  return pattern.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** A local's exported twin and the local itself are one binding. */
function normalize(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol ? checker.getExportSymbolOfSymbol(symbol) : undefined;
}

/**
 * True when `node` sits in a type, where a name is erased before anything
 * runs. Not a class's `extends`, which reads its value.
 */
function inTypeOnlyPosition(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n)) {
      const heritage = n.parent;
      const runs =
        ts.isExpressionWithTypeArguments(n) &&
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent));
      if (!runs) return true;
    }
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}
