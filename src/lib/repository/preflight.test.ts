/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * preflight()'s path rules: what a package may not hold because what would
 * land on disk would not be what its source shows. Each refusal comes before
 * anything is written, as `invalid-package`, naming the paths in its detail.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { InstallError, pathProblems, preflight } from "./install";
import type { TarEntry } from "./tar";

// ── fixtures ────────────────────────────────────────────────────────────────

const file = (path: string, data = "export {};\n"): TarEntry => ({ path, mode: 0o644, data: Buffer.from(data) });

/** A package that passes: a valid manifest and one route. */
const CLEAN = [file("app.json", '{"name":"Acme"}\n'), file("api/report/route.ts")];

/** Run preflight on CLEAN plus `paths`, returning the refusal (or null when it passes). */
function refusal(...paths: string[]): InstallError | null {
  try {
    preflight("app", "acme", [...CLEAN, ...paths.map((p) => file(p))]);
    return null;
  } catch (err) {
    assert.ok(err instanceof InstallError, `expected an InstallError, got ${String(err)}`);
    return err;
  }
}

/** Assert it is refused as invalid-package, with a detail matching each pattern. */
function assertRefused(err: InstallError | null, ...patterns: RegExp[]): void {
  assert.ok(err, "expected the package to be refused");
  assert.equal(err.code, "invalid-package");
  for (const pattern of patterns) assert.match(err.detail ?? "", pattern);
}

// ── what passes ─────────────────────────────────────────────────────────────

test("a package whose paths are what they say passes, non-ASCII names included", () => {
  assert.equal(refusal("pages/café/Main.tsx", "lib/ünïcödé.ts", "assets/日本.png", "api/Summary/route.ts"), null);
});

// ── names one disk would store as one ───────────────────────────────────────

describe("paths the same but for case or Unicode form", () => {
  test("api/report/route.ts beside API/report/route.ts", () => {
    const err = refusal("API/report/route.ts");
    assertRefused(err, /"api" and "API" differ only in case/, /case-insensitive/);
    assert.match(err!.message, /will not write/);
  });

  test("two files that differ only in case, in one folder", () => {
    assertRefused(refusal("lib/util.ts", "lib/Util.ts"), /"lib\/util\.ts" and "lib\/Util\.ts" differ only in case/);
  });

  test("an NFC and an NFD spelling of the same name, shown so the difference is visible", () => {
    const nfc = "pages/caf\u00e9/Main.tsx";
    const nfd = "pages/cafe\u0301/Main.tsx";
    assert.notEqual(nfc, nfd);
    assertRefused(
      refusal(nfc, nfd),
      /differ only in Unicode normalisation/,
      // Printed with the code points spelled out: the two look identical otherwise.
      /caf\\u\{E9\}/,
      /cafe\\u\{301\}/,
    );
  });

  test("letters only upper-casing folds together, \u017f and s", () => {
    assertRefused(refusal("lib/s.ts", "lib/\u017f.ts"), /differ only in case/);
  });

  test("each colliding pair is named once, however many files sit under it", () => {
    const err = refusal("API/report/route.ts", "API/other/route.ts", "api/other/route.ts");
    assertRefused(err);
    assert.equal(err!.detail!.split("\n").length, 1);
  });
});

// ── characters that change how a path prints ────────────────────────────────

describe("control and bidi characters in a path", () => {
  for (const [what, ch, shown] of [
    ["a newline", "\n", "\\u{A}"],
    ["a carriage return", "\r", "\\u{D}"],
    ["an escape (C0)", "\u001b", "\\u{1B}"],
    ["DEL", "\u007f", "\\u{7F}"],
    ["a C1 control", "\u009b", "\\u{9B}"],
    ["a right-to-left override", "\u202e", "\\u{202E}"],
    ["a left-to-right isolate", "\u2066", "\\u{2066}"],
    ["a right-to-left mark", "\u200f", "\\u{200F}"],
    ["a line separator", "\u2028", "\\u{2028}"],
  ] as const) {
    test(`${what} is refused, and printed escaped, never as itself`, () => {
      const err = refusal(`lib/a${ch}b.ts`);
      assertRefused(err, /control or bidi character/);
      assert.ok(err!.detail!.includes(`lib/a${shown}b.ts`), err!.detail);
      assert.ok(!err!.detail!.includes(ch), "the raw character reached the message");
    });
  }
});

// ── git control files ───────────────────────────────────────────────────────

describe("git control files at any depth", () => {
  for (const p of [".gitattributes", ".gitignore", "lib/.gitignore", "pages/a/b/.gitattributes", "lib/.GitIgnore"]) {
    test(p, () => {
      assertRefused(refusal(p), /git control file/);
    });
  }

  test("a .git folder, which git would treat as a repository of its own", () => {
    assertRefused(refusal("vendor/.git/config"), /git control file \(\.git\)/);
  });

  test("a name that only starts like one is fine", () => {
    assert.equal(refusal(".github/workflows/x.yml", "lib/.gitkeep", "docs/gitignore.md"), null);
  });
});

// ── order and shape ─────────────────────────────────────────────────────────

test("the path rules come before the manifest, and every problem is listed at once", () => {
  let err: unknown;
  try {
    // No manifest at all: the path problems are what is reported.
    preflight("app", "acme", [file("API/x.ts"), file("api/x.ts"), file(".gitignore"), file("a\u202eb.ts")]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof InstallError);
  assert.equal(err.code, "invalid-package");
  assert.equal(err.detail!.split("\n").length, 3);
});

test("pathProblems is empty for clean paths", () => {
  assert.deepEqual(pathProblems(["app.json", "api/a/route.ts", "api/b/route.ts", "README.md"]), []);
});
