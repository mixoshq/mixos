/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import * as ts from "typescript";
import {
  PACKAGES,
  PACKAGE_PATHS,
  PLATFORM,
  classifyImport,
  isScannedFile,
  renderAllowlist,
} from "./import-policy.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const UI = path.join(ROOT, "src/components/ui");

/** The file a platform specifier names: `@/lib/x` → src/lib/x.ts(x). */
function fileOf(specifier: string): string {
  const base = path.join(ROOT, "src", specifier.slice("@/".length));
  const file = [".ts", ".tsx"].map((ext) => base + ext).find((f) => fs.existsSync(f));
  assert.ok(file, `${specifier} names no file in src/`);
  return file;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/**
 * The names a module exports at runtime, read off its syntax. Type-only
 * exports are left out. With `isolatedModules` on, a type can only be
 * re-exported with `export type`, so a plain `export { X }` is a value.
 */
function runtimeExports(file: string): string[] {
  const names = new Set<string>();
  for (const statement of parse(file).statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
    ) {
      names.add(isDefault ? "default" : statement.name!.text);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.add("default");
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      assert.ok(statement.exportClause, `${file}: export * is not read by this test; list the names`);
      if (ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) if (!el.isTypeOnly) names.add(el.name.text);
      }
    }
  }
  return [...names].sort();
}

/** What a UI primitive may import at runtime: rendering, and nothing it could hand on. */
const PRESENTATIONAL = new Set(["react", "lucide-react", "next/link", "react-markdown", "remark-gfm", "@/lib/utils"]);

/**
 * Pure functions a primitive may read off a non-UI module to render something:
 * the connector error card asks the envelope module which causes are an
 * admin's to fix. The module's other exports stay off the app import list.
 */
const RENDERING_HELPERS = new Map([["@/lib/connectors/response", ["isAdminActionable"]]]);

/** A module's runtime imports and re-exports, with the names each takes; type-only ones left out. */
function runtimeImports(file: string): { specifier: string; names: string[] }[] {
  const out: { specifier: string; names: string[] }[] = [];
  for (const statement of parse(file).statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const names: string[] = [];
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
      }
      if (clause && names.length === 0) continue; // every name was a type
      out.push({ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, names });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      out.push({ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, names: ["*"] });
    }
  }
  return out;
}

/**
 * Everything a "*" entry hands every app, as of this commit. A new export from
 * one of these modules is app API the moment it lands, so it shows up here as
 * a diff for a reviewer to accept, against the four questions in
 * import-policy.mjs.
 */
const STAR_EXPORTS: Record<string, string[]> = {
  "@/lib/apps/sdk": [
    "AppClientError",
    "connectorErrorOf",
    "createAppClient",
    "disablePushNotifications",
    "enablePushNotifications",
    "getPushPermission",
    "isPushSubscribed",
    "isPushSupported",
    "track",
  ],
  "@/lib/apps/use-app-query": ["useAppQuery"],
  "@/lib/apps/widget-config-presets": ["displayModeField", "groupByField", "selectionField", "titleField"],
  "@/lib/use-client-value": ["useClientValue"],
  "@/components/ui/app-page-header": ["default"],
  "@/components/ui/app-states": ["EmptyState", "ErrorState", "PendingState"],
  "@/components/ui/async-view": ["AsyncView"],
  "@/components/ui/badge": ["Badge", "categoricalTone"],
  "@/components/ui/button": ["Button", "IconButton"],
  "@/components/ui/card": [
    "CARD_BODY",
    "CARD_BODY_DIVIDED",
    "CARD_DESCRIPTION",
    "CARD_HEADER",
    "CARD_HEADER_RIGHT",
    "CARD_HEADER_ROW",
    "CARD_SHELL",
    "CARD_SURFACE",
    "CARD_TITLE",
    "Card",
    "CardBody",
    "CardHeader",
  ],
  "@/components/ui/configure-shell": ["default"],
  "@/components/ui/connector-error-state": ["default"],
  "@/components/ui/data-table": ["DataTable", "TableSkeleton"],
  "@/components/ui/dialog": ["Dialog"],
  "@/components/ui/field": ["Field"],
  "@/components/ui/folder-tabs": ["default"],
  "@/components/ui/info-tooltip": ["InfoTooltip"],
  "@/components/ui/input": ["Checkbox", "Input", "Select", "Switch", "Textarea"],
  "@/components/ui/markdown": ["Markdown"],
  "@/components/ui/menu": ["ContextMenu", "Menu"],
  "@/components/ui/notice": ["default"],
  "@/components/ui/pagination": ["Button", "Pagination"],
  "@/components/ui/section-card": ["AddRow", "NumberField", "SaveRow", "SectionCard", "TextField", "numStr", "toNum"],
  "@/components/ui/skeleton": ["Skeleton"],
  "@/components/ui/status": ["StatusDot", "StatusPill", "StatusSwatch"],
  "@/components/ui/toast": ["ToastProvider", "useToast"],
  "@/components/ui/toggle": ["Toggle"],
};

describe("the list", () => {
  test("every listed name is a runtime export of its module", () => {
    for (const [specifier, { names }] of PLATFORM) {
      if (names === "*") continue;
      const exported = runtimeExports(fileOf(specifier));
      for (const name of names) {
        assert.ok(exported.includes(name), `${specifier} does not export ${name} at runtime; the entry is stale`);
      }
    }
  });

  test('every "*" module exports exactly what the snapshot says', () => {
    const actual: Record<string, string[]> = {};
    for (const [specifier, { names }] of PLATFORM) {
      if (names !== "*") continue;
      if (specifier.endsWith("/*")) {
        const dir = path.join(ROOT, "src", specifier.slice("@/".length, -"/*".length));
        for (const file of fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))) {
          actual[`${specifier.slice(0, -1)}${file.replace(/\.tsx?$/, "")}`] = runtimeExports(path.join(dir, file));
        }
      } else {
        actual[specifier] = runtimeExports(fileOf(specifier));
      }
    }
    assert.deepEqual(actual, STAR_EXPORTS);
  });

  test("every UI primitive imports only presentational modules, or types", () => {
    for (const file of fs.readdirSync(UI).filter((f) => /\.tsx?$/.test(f))) {
      for (const { specifier, names } of runtimeImports(path.join(UI, file))) {
        const helpers = RENDERING_HELPERS.get(specifier);
        const ok =
          PRESENTATIONAL.has(specifier) ||
          specifier.startsWith("@/components/ui/") ||
          (specifier.startsWith("./") && !specifier.slice(2).includes("/")) ||
          (helpers !== undefined && names.every((name) => helpers.includes(name)));
        assert.ok(
          ok,
          `src/components/ui/${file} imports ${names.join(", ")} from "${specifier}", which every app would get through it`,
        );
      }
    }
  });

  test("tsconfig leaves verbatimModuleSyntax off, so `import { type A }` is erased whole", () => {
    // With it on, an import whose every name is a type still loads the module
    // for its side effects, and the inline form would stop being type-only.
    const { config } = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
    assert.ok(!config.compilerOptions?.verbatimModuleSyntax);
    assert.ok(!config.compilerOptions?.preserveValueImports);
  });

  test("docs/apps/architecture.md shows the list as the policy has it", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/apps/architecture.md"), "utf8");
    const match = doc.match(/<!-- BEGIN app-imports[^>]*-->\n([\s\S]*?)\n<!-- END app-imports -->/);
    assert.ok(match, "docs/apps/architecture.md has no app-imports block");
    assert.equal(match[1], renderAllowlist(), "Run `npx tsx scripts/generate-import-docs.ts` to regenerate it.");
  });
});

describe("classifyImport", () => {
  const appDir = path.join(ROOT, "apps", "probe");
  const importer = path.join(appDir, "api/a/route.ts");
  const verdict = (specifier: string, more: Partial<Parameters<typeof classifyImport>[0]> = {}) =>
    classifyImport({ specifier, importer, appDir, ...more });

  test("packages by name, next by exact path", () => {
    for (const name of PACKAGES) assert.equal(verdict(name), null);
    for (const specifier of PACKAGE_PATHS) assert.equal(verdict(specifier), null);
    assert.equal(verdict("react/jsx-runtime"), null);
    assert.equal(verdict("zod/v4"), null);
    assert.match(verdict("next/headers")?.why ?? "", /belongs to the platform/);
    assert.match(verdict("next/link.js")?.why ?? "", /belongs to the platform/);
    assert.match(verdict("react-dom")?.why ?? "", /not a package MixOS provides/);
  });

  test("listed names pass, others do not, and neither does the whole module", () => {
    assert.equal(verdict("@/lib/apps/route", { names: ["defineRoute", "AppError", "isAppError"] }), null);
    assert.equal(verdict("@/lib/apps/route"), null);
    assert.deepEqual(verdict("@/lib/apps/route", { names: ["defineRoute", "runRoute"] }), {
      what: 'import { runRoute } from "@/lib/apps/route"',
      why: 'is not app API. From "@/lib/apps/route" an app may import defineRoute, AppError, isAppError.',
    });
    assert.match(verdict("@/lib/apps/route", { namespace: true })?.why ?? "", /takes every export/);
    assert.equal(verdict("@/lib/apps/sdk", { namespace: true }), null);
  });

  test("a type-only import is never refused", () => {
    for (const specifier of ["@/lib/db/client", "@connectors/google-sheets", "@apps/other/x", "fs", "data:x"]) {
      assert.equal(verdict(specifier, { typeOnly: true }), null, specifier);
    }
  });

  test("no Node built-in is on the list", () => {
    for (const specifier of ["crypto", "node:crypto", "buffer", "url", "util", "path"]) {
      assert.match(verdict(specifier)?.why ?? "", /Node built-in/, specifier);
    }
  });
});

describe("isScannedFile", () => {
  const appDir = path.join(ROOT, "apps", "probe");
  const scanned = (rel: string) => isScannedFile(appDir, path.join(appDir, rel));

  test("source anywhere in the app, in every extension a bundler runs", () => {
    for (const rel of ["api/a/route.ts", "pages/Main.tsx", "lib/a.js", "lib/b.mjs", "lib/c.cjs", "lib/d.mts", "lib/e.jsx", "lib/assets/f.ts"]) {
      assert.ok(scanned(rel), rel);
    }
  });

  test("not dot-directories, node_modules, the root non-code directories or declaration files", () => {
    for (const rel of [
      ".hidden/a.ts",
      "lib/.cache/a.ts",
      "lib/node_modules/a/index.js",
      "assets/a.ts",
      "plans/a.ts",
      "migrations/a.ts",
      "screenshots/a.ts",
      "lib/types.d.ts",
      "lib/types.d.mts",
      "styles/a.d.css.ts",
      "assets/logo.png",
      "app.json",
    ]) {
      assert.ok(!scanned(rel), rel);
    }
    assert.ok(!isScannedFile(appDir, path.join(ROOT, "src/lib/utils.ts")));
  });
});

test("the packages named in the policy are the platform's own dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const name of [...PACKAGES, ...[...PACKAGE_PATHS].map((p) => p.split("/")[0])]) {
    assert.ok(pkg.dependencies?.[name], `${name} is not in package.json dependencies`);
  }
});
