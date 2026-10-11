/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import * as ts from "typescript";
import type { ConnectorTelemetryDefinition } from "../src/lib/connectors/types";

/**
 * The registry generator's checks on a connector's declared methods: the
 * `telemetry` list carried into the registry, and held to the class it
 * describes.
 *
 * Its own module so it can be tested. The generator runs on import, so nothing
 * inside it can be.
 */

/**
 * Carry through the connector's declared methods, failing the build on a
 * duplicate method (a duplicate is almost always a copy-paste bug and would make
 * the admin breakdown ambiguous). Shape is already schema-validated.
 *
 * `mutates` is carried with the rest. The MCP context reads it from the
 * generated registry to refuse a write from a read-only tool, so a list that
 * dropped it here would switch that check off without a sound.
 */
export function validateConnectorTelemetry(
  raw: { method: string; description?: string; mutates?: boolean }[] | undefined,
  name: string,
): ConnectorTelemetryDefinition[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (seen.has(e.method)) {
      throw new Error(
        `connectors/${name}/connector.json: duplicate telemetry method "${e.method}".`,
      );
    }
    seen.add(e.method);
  }
  return raw.map((e) => ({
    method: e.method,
    ...(e.description != null ? { description: e.description } : {}),
    ...(e.mutates ? { mutates: true } : {}),
  }));
}

/**
 * Base-class contract, not app-callable surface. The platform calls these; an
 * app never can, so they are not capabilities and are not declared.
 */
const CONNECTOR_RESERVED_METHODS = new Set([
  "initialize",
  "testConnection",
  "handleWebhook",
]);

/**
 * Public methods every connector has through `HttpConnector` itself, whether
 * or not its own file overrides them.
 */
const INHERITED_METHODS = new Set(["initialize", "testConnection"]);

/** The name a member is called by, or null when it has none an app could use. */
function memberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  // `#private`, or a name computed at runtime.
  return null;
}

/**
 * Is this property's initial value a function — `() => …`, `function () {…}`,
 * or `this.other.bind(this)` — seen through parentheses and type assertions?
 */
function initializesFunction(initializer: ts.Expression | undefined): boolean {
  let node = initializer;
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression;
  }
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "bind"
  );
}

/**
 * Every public method on a connector class must be declared in `telemetry`.
 *
 * WHY THIS IS A BUILD ERROR AND NOT A LINT. The Connector Registry's Access tab
 * answers "what can this reach, and can it change anything" from `telemetry`
 * plus each entry's `mutates`. That answer is only trustworthy if the list is
 * COMPLETE — and `telemetry` was designed as opt-in instrumentation, so nothing
 * made it so. A connector could ship a `sendMessage()`, leave it undeclared,
 * and the tab would report "no method changes anything upstream" about a
 * connector that sends mail.
 *
 * Under-reporting is the one failure a permissions view cannot have: the whole
 * reason an admin opens it is to find out what this thing could do to their
 * data. Over-reporting is a nuisance; under-reporting is a false assurance.
 *
 * A method is anything an app can call. That includes a property initialised
 * with a function (`createItem = async () => …`): at runtime it is a method
 * like any other, but in the syntax tree it is a property, and a check that
 * looked only at method declarations let one ship undeclared.
 *
 * Parsed from the AST rather than by regex, because the answer has to be right:
 * a regex cannot tell a method on the connector class from one on a helper
 * class in the same file, nor see the `private` that makes it not count.
 *
 * The other direction holds too: every declared method must be one the class
 * actually has, public. A declared name that matches nothing — a typo, a
 * method since renamed — is never counted and is no read an MCP tool can
 * call, so the list would describe a connector that does not exist.
 */
export function validateConnectorMethods(
  name: string,
  dir: string,
  telemetry: readonly ConnectorTelemetryDefinition[],
): void {
  const entry = path.join(dir, "index.ts");
  if (!fs.existsSync(entry)) return;

  const source = ts.createSourceFile(
    entry,
    fs.readFileSync(entry, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const declared = new Set(telemetry.map((t) => t.method));
  const undeclared = new Set<string>();
  /** Every public method an app can call on the connector classes here. */
  const callable = new Set<string>();
  /** Whether a connector class was found here at all. */
  let sawConnector = false;
  /**
   * Whether a connector class here extends something this file cannot see —
   * neither `HttpConnector` nor a class declared alongside it. Its inherited
   * methods are then unknown, so a declared one cannot be proved missing.
   */
  let inheritsUnseen = false;

  const classes = new Map<string, ts.ClassDeclaration>();
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      classes.set(statement.name.text, statement);
    }
  }

  /**
   * The public callable members of one class: its methods, and its properties
   * initialised with a function.
   */
  const publicMethods = (cls: ts.ClassDeclaration) => {
    const out: string[] = [];
    for (const member of cls.members) {
      const isCallable =
        ts.isMethodDeclaration(member) ||
        (ts.isPropertyDeclaration(member) &&
          initializesFunction(member.initializer));
      if (!isCallable) continue;
      const methodName = memberName(member.name);
      if (methodName === null) continue;
      const modifiers = ts.getModifiers(member) ?? [];
      const hidden = modifiers.some(
        (m) =>
          m.kind === ts.SyntaxKind.PrivateKeyword ||
          m.kind === ts.SyntaxKind.ProtectedKeyword ||
          m.kind === ts.SyntaxKind.StaticKeyword,
      );
      if (!hidden) out.push(methodName);
    }
    return out;
  };

  /** The class a class extends, by name, when that is a plain identifier. */
  const baseName = (cls: ts.ClassDeclaration): string | null | undefined => {
    const clause = cls.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    if (!clause) return undefined;
    const expression = clause.types[0]?.expression;
    return expression && ts.isIdentifier(expression) ? expression.text : null;
  };

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    // Only a class that extends something — i.e. the connector, not a local
    // helper or a plain data class defined alongside it.
    if (baseName(statement) === undefined) continue;
    sawConnector = true;

    for (const methodName of publicMethods(statement)) {
      callable.add(methodName);
      if (
        CONNECTOR_RESERVED_METHODS.has(methodName) ||
        declared.has(methodName)
      ) {
        continue;
      }
      undeclared.add(methodName);
    }

    // What it inherits. A base class declared in this file contributes its own
    // public methods; `HttpConnector` contributes the base contract; anything
    // else is out of sight.
    const seen = new Set<string>();
    let base = baseName(statement);
    while (base !== "HttpConnector") {
      const local = base ? classes.get(base) : undefined;
      if (!base || !local || seen.has(base)) {
        inheritsUnseen = true;
        break;
      }
      seen.add(base);
      for (const methodName of publicMethods(local)) callable.add(methodName);
      base = baseName(local);
      // A base declared here that extends nothing: the whole chain was seen.
      if (base === undefined) break;
    }
  }

  if (undeclared.size > 0) {
    throw new Error(
      `connector.json: these public methods are not declared in "telemetry": ` +
        `${[...undeclared].join(", ")}.\n` +
        `  The Connector Registry reports what a connector can do from that list, ` +
        `so an undeclared method is one an admin is never told about — and if it ` +
        `writes, the registry says this connector changes nothing.\n` +
        `  Add each with a description and, when it changes anything upstream, ` +
        `"mutates": true. Make it private if apps should not call it.`,
    );
  }

  if (!sawConnector || inheritsUnseen) return;
  const missing = [...declared].filter(
    (method) => !callable.has(method) && !INHERITED_METHODS.has(method),
  );
  if (missing.length > 0) {
    throw new Error(
      `connector.json: "telemetry" declares methods the connector class does not have: ` +
        `${missing.join(", ")}.\n` +
        `  A declared method that does not exist is never counted, and is no read an ` +
        `MCP tool can call — it is almost always a typo, or a method since renamed.\n` +
        `  Fix the name, or remove the entry. A private, protected or static method ` +
        `does not count: an app cannot call it.`,
    );
  }
}

/**
 * The Connector Registry contract: what a connector must declare for its admin
 * experience to exist at all.
 *
 * These are not stylistic preferences. Each one is a specific hole in the
 * registry when it is absent:
 *
 *   · no `icon`         — an unidentifiable tile in a grid of tiles
 *   · no `setup`        — a Configure wizard whose first step is blank, so the
 *                         admin is asked for a Client ID with no idea where to
 *                         get one
 *   · no `scopesUrl`    — a permissions list that can never be populated, and
 *                         no way to answer "what can this reach". Required
 *                         only of a connector that authenticates: one with
 *                         `auth.strategy` "none" reaches a public API, which
 *                         grants no permissions and has no page listing them.
 *
 * Reported together rather than one per run: an author adding a connector
 * should learn everything that is missing in one build, not discover it three
 * builds in a row.
 *
 * See docs/connectors/registry-ux.md.
 */
export function validateRegistryContract(
  name: string,
  raw: {
    icon?: string;
    auth?: { strategy?: string; scopesUrl?: string };
    setup?: { title?: string; steps?: unknown[] };
  },
): void {
  const missing: string[] = [];

  if (!raw.icon) {
    missing.push(
      '"icon" — a square PNG or WebP of at least 512x512, or an SVG with a viewBox, in this connector\'s assets/',
    );
  }
  if ((raw.auth?.strategy ?? "none") !== "none" && !raw.auth?.scopesUrl) {
    missing.push(
      '"auth.scopesUrl" — the provider\'s scope reference page, which the registry parses to list permissions in plain English',
    );
  }
  if (!raw.setup?.title) {
    missing.push(
      '"setup.title" — the label for the provider-side step, e.g. "Create a Google Cloud OAuth app"',
    );
  }
  if (!raw.setup?.steps || raw.setup.steps.length === 0) {
    missing.push(
      '"setup.steps" — at least one step covering what the admin does in the provider\'s own console',
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `connector.json is missing what the Connector Registry needs:\n` +
        missing.map((m) => `    - ${m}`).join("\n") +
        `\n  Every connector ships a configuration experience; these are the parts ` +
        `the platform cannot invent. See docs/connectors/registry-ux.md.`,
    );
  }
}
