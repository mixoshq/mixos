/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { gitBlobSha, gitTreeSha, isInlineText } from "./git-objects";

// The ids below are git's own, from `git ls-files -s` and `git rev-parse
// <tree>:ext` over the same files.
describe("git object ids", () => {
  test("a blob's id is git's", () => {
    assert.equal(gitBlobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert.equal(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
    assert.equal(gitBlobSha(Buffer.from([0, 1, 2, ...Buffer.from("binary")])), "0f49c4ae77b43dff338093c78e009676e7e308ba");
  });

  test("a tree's id is git's, with folders sorted as git sorts them", () => {
    const files = [
      // Out of order on purpose: "a-b" < "a.txt" < "a/", and capitals first.
      { path: "lib/icon.bin", data: Buffer.from([0, 1, 2, ...Buffer.from("binary")]) },
      { path: "a/b.ts", data: Buffer.from("export const x = 1;\n") },
      { path: "a.txt", data: Buffer.from("hello\n") },
      { path: "app.json", data: Buffer.from('{"name":"X"}\n') },
      { path: "a-b", data: Buffer.from("A") },
      { path: "lib/empty.txt", data: Buffer.alloc(0) },
      { path: "Z.md", data: Buffer.from("z") },
    ];
    assert.equal(gitTreeSha(files), "aeddbc1799ff0dc4a21bb58bbf6a1a4d3e54da4c");
    assert.equal(gitTreeSha(files.filter((f) => f.path.startsWith("a/")).map((f) => ({ ...f, path: "b.ts" }))), "db6bccad397ff9a08b18ecd7f98b0e9ef9788c0c");
    assert.equal(gitTreeSha([]), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("a path twice, or a file where a folder goes, is refused", () => {
    assert.throws(() => gitTreeSha([{ path: "a", data: Buffer.from("1") }, { path: "a", data: Buffer.from("2") }]), /twice/);
    assert.throws(() => gitTreeSha([{ path: "a", data: Buffer.from("1") }, { path: "a/b", data: Buffer.from("2") }]), /folder/);
  });

  test("text goes inline only when it comes back byte for byte", () => {
    assert.equal(isInlineText(Buffer.from("plain\r\nwith CRLF and   and é\n")), true);
    assert.equal(isInlineText(Buffer.from("﻿a BOM\n")), true);
    assert.equal(isInlineText(Buffer.alloc(0)), true);
    assert.equal(isInlineText(Buffer.from([0x61, 0x00, 0x62])), false, "a NUL");
    assert.equal(isInlineText(Buffer.from([0xff, 0xfe, 0x41])), false, "not UTF-8");
    assert.equal(isInlineText(Buffer.from([0xe9])), false, "Latin-1");
  });
});
