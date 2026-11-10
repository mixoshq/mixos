/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * preflight()'s path rules: what a package may not hold because what would
 * land on disk would not be what its source shows. Each refusal comes before
 * anything is written, as `invalid-package`, naming the paths in its detail.
 * And leaveOut(): the `.gitignore` and `.gitattributes` install leaves out
 * instead, which the rules skip.
 *
 * mixos.org's publish check follows pathProblems(), and its tests follow
 * these, so a case here that changes is one to change there.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { InstallError, leaveOut, pathProblems, preflight } from "./install";
import { leftOutLine } from "./left-out";
import type { TarEntry } from "./tar";

// ── fixtures ────────────────────────────────────────────────────────────────

const file = (path: string, data = "export {};\n"): TarEntry => ({ path, mode: 0o644, data: Buffer.from(data) });

/** A package that passes: a valid manifest and one route. */
const CLEAN = [file("app.json", '{"$schema":"https://mixos.org/schemas/app/v1.json","name":"Acme"}\n'), file("api/report/route.ts")];

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

  test("a folder holding one is named once, not once per file in it", () => {
    const err = refusal("a\u202eb/x.ts", "a\u202eb/y.ts");
    assertRefused(err, /^"a\\u\{202E\}b" has a control or bidi character/);
    assert.equal(err!.detail!.split("\n").length, 1);
  });
});

// ── .git, and the install record ────────────────────────────────────────────

describe("a .git file or folder at any depth", () => {
  for (const [p, named] of [
    ["vendor/.git/config", "vendor/.git"],
    [".git/HEAD", ".git"],
    ["lib/sub/.git", "lib/sub/.git"],
    ["vendor/.GIT/config", "vendor/.GIT"],
  ] as const) {
    test(p, () => {
      const err = refusal(p);
      assertRefused(err, /makes git treat the folder it is in as a repository of its own/);
      assert.ok(err!.detail!.startsWith(`"${named}" `), err!.detail);
    });
  }

  test("a .git folder is named once, however many files are in it", () => {
    const err = refusal("vendor/.git/config", "vendor/.git/HEAD", "vendor/.git/objects/ab/cdef");
    assertRefused(err);
    assert.equal(err!.detail!.split("\n").length, 1);
  });

  test("a name that only starts like one is fine", () => {
    assert.equal(refusal(".github/workflows/x.yml", "lib/.gitkeep", "docs/gitignore.md"), null);
  });
});

describe("a file or folder named like the install record, at any depth", () => {
  for (const [p, named] of [
    [".registry.json", ".registry.json"],
    ["lib/.registry.json", "lib/.registry.json"],
    [".Registry.JSON", ".Registry.JSON"],
    ["assets/.registry.json/x.txt", "assets/.registry.json"],
  ] as const) {
    test(p, () => {
      const err = refusal(p);
      assertRefused(err, /named like the install record \(\.registry\.json\), which only an install writes/);
      assert.ok(err!.detail!.startsWith(`"${named}" `), err!.detail);
    });
  }

  test("a name that only resembles it is fine", () => {
    assert.equal(refusal("registry.json", "lib/.registry.jsonc", "docs/.registry.json.md"), null);
  });
});

// ── what install leaves out ─────────────────────────────────────────────────

describe(".gitignore and .gitattributes, which install leaves out", () => {
  test("are not refused, at any depth, in any case", () => {
    assert.equal(refusal(".gitignore", ".gitattributes", "lib/.gitignore", "pages/a/b/.gitattributes", "lib/.GitIgnore"), null);
  });

  test("take no part in a clash, since they never land on disk", () => {
    // LIB/ would hold only a .gitignore, so it never exists to clash with lib/.
    assert.equal(refusal("lib/x.ts", "LIB/.gitignore"), null);
    assert.equal(refusal(".gitignore", ".GITIGNORE"), null);
  });

  test("are skipped before every other rule, since nothing about them is written", () => {
    assert.equal(refusal("a\u202eb/.gitignore", "vendor/.git/.gitattributes", "x/.registry.json/.gitignore"), null);
    // The same folders holding a file install writes are refused as before.
    assert.equal(pathProblems(["a\u202eb/x.ts", "vendor/.git/config", "x/.registry.json/y.ts"]).length, 3);
  });

  test("only as a file's own name: a folder of that name is written, and checked", () => {
    assert.equal(refusal(".gitignore/notes.md", "lib/.gitattributes.d/x.ts"), null);
    assertRefused(refusal(".gitignore/A.md", ".gitignore/a.md"), /differ only in case/);
  });

  test("leaveOut() drops them, at any depth and in any case, and counts them by name", () => {
    const entries = [
      file("app.json"),
      file(".gitignore"),
      file("lib/.gitattributes"),
      file("lib/util.ts"),
      file("assets/.GitIgnore"),
      file(".gitignore/notes.md"),
      file("docs/gitignore.md"),
    ];
    const { written, leftOut } = leaveOut(entries);
    assert.deepEqual(
      written.map((e) => e.path),
      ["app.json", "lib/util.ts", ".gitignore/notes.md", "docs/gitignore.md"],
    );
    assert.deepEqual(leftOut, { ".gitignore": 2, ".gitattributes": 1 });
    // In the names' own order, whatever order the archive has them in.
    assert.deepEqual(Object.keys(leaveOut([file("a/.gitattributes"), file(".gitignore")]).leftOut), [".gitignore", ".gitattributes"]);
    assert.deepEqual(leaveOut([file("app.json")]), { written: [file("app.json")], leftOut: {} });
  });

  test("leftOutLine() says what was left out in one line, or nothing", () => {
    assert.equal(leftOutLine({}), null);
    assert.equal(leftOutLine({ ".gitignore": 1 }), "Left out .gitignore (1 file): MixOS doesn't install git control files.");
    assert.equal(
      leftOutLine({ ".gitattributes": 1, ".gitignore": 2 }),
      "Left out .gitignore (2 files) and .gitattributes (1 file): MixOS doesn't install git control files.",
    );
  });
});

// ── order and shape ─────────────────────────────────────────────────────────

test("the path rules come before the manifest, and every problem is listed at once", () => {
  let err: unknown;
  try {
    // No manifest at all: the path problems are what is reported. The
    // .gitignore is left out, so it isn't one of them.
    preflight("app", "acme", [
      file("API/x.ts"),
      file("api/x.ts"),
      file(".git/config"),
      file("a\u202eb.ts"),
      file(".gitignore"),
      file(".registry.json"),
    ]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof InstallError);
  assert.equal(err.code, "invalid-package");
  assert.equal(err.detail!.split("\n").length, 4);
});

test("pathProblems is empty for clean paths", () => {
  assert.deepEqual(pathProblems(["app.json", "api/a/route.ts", "api/b/route.ts", "README.md"]), []);
});
