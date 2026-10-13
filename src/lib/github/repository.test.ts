/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a write token may write: refs only under refs/heads/mixos/, tree paths
 * only under the operation's folder, no merge endpoint, no default branch, no
 * auto-merge, and names that skip no checks. Then a MixOS update's narrower
 * scope: one ref at one commit, once, and one pull request, and nothing else.
 * Every refusal happens before a request is sent; `fetch` here fails the test
 * if it is reached.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError, githubRequest } from "./api";
import { guardWrite, isExtensionFolder, isUpdateBranch, linkedRepository, type WriteScope } from "./repository";
import type { RepositoryRecord } from "./store";

const record: RepositoryRecord = {
  id: 501,
  owner: "acme",
  name: "mixos",
  defaultBranch: "main",
  private: true,
  fork: true,
  parent: null,
};
const scope: WriteScope = { folder: "apps/files", action: "install" };
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const sent: { url: string; method: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  sent.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const write = () => linkedRepository(record, "write", "ghs_test", scope);

async function refused(suffix: string, body: unknown, pattern?: RegExp, repo = write()): Promise<void> {
  await assert.rejects(repo.post(suffix, body), (err: unknown) => {
    assert.ok(err instanceof GitHubError, String(err));
    assert.equal(err.failure, "path");
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
  assert.equal(sent.length, 0, `nothing sent for ${suffix}`);
}

const tree = (entries: unknown[]) => ({ base_tree: SHA, tree: entries });
const file = (path: string, extra: Record<string, unknown> = { content: "x" }) => ({ path, mode: "100644", type: "blob", ...extra });

describe("what a write token may write", () => {
  test("only a write token with a scope writes", async () => {
    await refused("/git/blobs", { content: "eA==", encoding: "base64" }, /bug in the caller/, linkedRepository(record, "read", "t"));
    await refused("/git/blobs", { content: "eA==", encoding: "base64" }, /bug in the caller/, linkedRepository(record, "write", "t"));
    await refused("/git/blobs", { content: "eA==", encoding: "base64" }, /extension's folder/, linkedRepository(record, "write", "t", { folder: "src/lib", action: "install" }));
    await refused("/git/blobs", { content: "eA==", encoding: "base64" }, /what the operation does/, linkedRepository(record, "write", "t", { folder: "apps/files", action: "merge" as "install" }));
    for (const folder of ["apps/Files", "apps/files/sub", "apps/", "apps/../x", "plugins/files", "apps/a"]) {
      assert.equal(isExtensionFolder(folder), false, folder);
    }
    assert.equal(isExtensionFolder("connectors/stripe-billing"), true);
  });

  test("no merge endpoint, ref update, dispatch or anything else", async () => {
    for (const suffix of [
      "/merges",
      "/merge-upstream",
      "/pulls/1/merge",
      "/pulls/1/reviews",
      "/git/refs/heads/mixos/install/app-files",
      "/git/tags",
      "/dispatches",
      "/actions/workflows/ci.yml/dispatches",
      "/contents/apps/files/app.json",
      "/issues",
      "/auto-merge",
      "",
    ]) {
      await refused(suffix, { base: "main", head: "mixos/install/app-files", sha: SHA }, /doesn't POST/);
    }
    // The client can't send a PUT or a PATCH at all.
    for (const method of ["PUT", "PATCH"]) {
      await assert.rejects(
        githubRequest("/repos/acme/mixos/pulls/1/merge", { method: method as "POST", auth: { kind: "installation", token: "t" } }),
        /method this client doesn't use/,
      );
    }
    assert.equal(sent.length, 0);
  });

  test("refs only under refs/heads/mixos/, never the default branch or a tag", async () => {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature",
      "refs/tags/v1.0.0",
      "refs/tags/mixos/x",
      "heads/mixos/install/app-files",
      "refs/heads/mixos/../main",
      "refs/heads/mixos/x.lock",
      "refs/heads/mixos//x",
      "refs/heads/mixos/x y",
      "refs/heads/Mixos/x",
    ]) {
      await refused("/git/refs", { ref, sha: SHA }, /branches under mixos\//);
    }
    await refused("/git/refs", { ref: "refs/heads/mixos/install/app-files", sha: SHA, force: true }, /isn't a ref/);
    const mixosDefault = linkedRepository({ ...record, defaultBranch: "mixos/main" }, "write", "t", scope);
    await refused("/git/refs", { ref: "refs/heads/mixos/main", sha: SHA }, /default branch/, mixosDefault);
    await refused("/git/refs", { ref: "refs/heads/mixos/install/app-files", sha: SHA }, /default branch/, mixosDefault);

    await write().post("/git/refs", { ref: "refs/heads/mixos/install/app-files", sha: SHA });
    assert.deepEqual(sent, [
      {
        url: "https://api.github.com/repos/acme/mixos/git/refs",
        method: "POST",
        body: { ref: "refs/heads/mixos/install/app-files", sha: SHA },
      },
    ]);
  });

  test("tree paths only under the folder, each a file with mode 100644", async () => {
    for (const path of ["apps/other/x.ts", "apps/files", "apps/filesx/a", "connectors/files/a", "apps/files/../x", "apps/files//x", "apps/files/./x", "apps/files/.git/config", "apps/files/a/.GIT", "apps/files/a‮b", "apps/files/a\\b", "/apps/files/x", "x"]) {
      await refused("/git/trees", tree([file(path)]), undefined);
    }
    await refused("/git/trees", tree([file("apps/files/a", { mode: "100755", content: "x" })]), /isn't a tree/);
    await refused("/git/trees", tree([{ path: "apps/files/a", mode: "040000", type: "tree", sha: SHA }]), /isn't a tree/);
    await refused("/git/trees", tree([file("apps/files/a", { content: "x", sha: SHA })]), /one of the two/);
    await refused("/git/trees", tree([file("apps/files/a", {})]), /one of the two/);
    // An install deletes nothing.
    await refused("/git/trees", tree([file("apps/files/a", { sha: null })]), /an install deletes nothing/);
    await refused("/git/trees", tree([file("apps/files/a"), file("apps/files/A")]), /twice/);
    await refused("/git/trees", { base_tree: "main", tree: [file("apps/files/a")] }, /isn't a tree/);
    await refused("/git/trees", { tree: [file("apps/files/a")] }, /isn't a tree/);

    await write().post("/git/trees", tree([file("apps/files/app.json"), file("apps/files/api/[id]/route.ts", { sha: SHA2 })]));
    assert.equal(sent.length, 1);
  });

  test("a deletion only in an update's or a removal's scope, and only inside the folder", async () => {
    const update = () => linkedRepository(record, "write", "ghs_test", { folder: "apps/files", action: "update" });
    const removal = () => linkedRepository(record, "write", "ghs_test", { folder: "apps/files", action: "remove" });
    for (const path of ["apps/other/x.ts", "apps/filesx/a", "connectors/files/a", "apps/files/../x", "apps/files/.git/config", "src/lib/x.ts", "apps/files"]) {
      await refused("/git/trees", tree([file(path, { sha: null })]), undefined, update());
      await refused("/git/trees", tree([file(path, { sha: null })]), undefined, removal());
    }
    await refused("/git/trees", tree([file("apps/files/a", { sha: null, content: "x" })]), /deleted and written at once/, update());
    await refused("/git/trees", tree([file("apps/files/a", { sha: null }), file("apps/files/A", { content: "x" })]), /twice/, update());
    await refused("/git/trees", tree([file("apps/files/a", { sha: "x" })]), /isn't a tree/, update());
    // Everything else holds for them as for an install.
    await refused("/git/refs", { ref: "refs/heads/main", sha: SHA }, /branches under mixos\//, update());
    await refused("/pulls", { title: "Update app files to 1.3.0 [skip preview]", head: "mixos/update/app-files", base: "release", body: "x" }, /default branch only/, update());
    await refused("/merges", { base: "main", head: "mixos/remove/app-files" }, /doesn't POST/, removal());

    // An update: new files, and deletions, in one tree. A removal: deletions alone.
    await update().post("/git/trees", tree([file("apps/files/app.json"), file("apps/files/old.ts", { sha: null }), file("apps/files/assets/a.png", { sha: SHA2 })]));
    await removal().post("/git/trees", tree([file("apps/files/app.json", { sha: null }), file("apps/files/.registry.json", { sha: null })]));
    assert.equal(sent.length, 2);
    assert.deepEqual((sent[1].body as { tree: unknown[] }).tree, [
      { path: "apps/files/app.json", mode: "100644", type: "blob", sha: null },
      { path: "apps/files/.registry.json", mode: "100644", type: "blob", sha: null },
    ]);
  });

  test("a commit with one parent, the App's own author, and no skip marker", async () => {
    await refused("/git/commits", { message: "Add app files 1.2.0 [skip ci]", tree: SHA, parents: [SHA2] }, /\[skip ci\]/);
    await refused("/git/commits", { message: "Add\n\nskip-checks: true", tree: SHA, parents: [SHA2] }, /skip-checks/);
    await refused("/git/commits", { message: "Add [render preview]", tree: SHA, parents: [SHA2] }, /render preview/);
    await refused("/git/commits", { message: "Add", tree: SHA, parents: [SHA2], author: { name: "x", email: "x@y" } }, /isn't a commit/);
    await refused("/git/commits", { message: "Add", tree: SHA, parents: [SHA2, SHA] }, /isn't a commit/);
    await refused("/git/commits", { message: "Add", tree: SHA, parents: [] }, /isn't a commit/);
    await write().post("/git/commits", { message: "Add app files 1.2.0 from mixos.org", tree: SHA, parents: [SHA2] });
    assert.equal(sent.length, 1);
  });

  test("a pull request from a mixos/ branch, into the default branch, with a clean title", async () => {
    const pull = { title: "Add app files 1.2.0 from mixos.org [skip preview]", head: "mixos/install/app-files", base: "main", body: "x" };
    await refused("/pulls", { ...pull, base: "release" }, /default branch only/);
    await refused("/pulls", { ...pull, head: "acme:mixos/install/app-files" }, /branch under mixos\//);
    await refused("/pulls", { ...pull, head: "feature" }, /branch under mixos\//);
    await refused("/pulls", { ...pull, title: "Add\nfiles" }, /one line/);
    await refused("/pulls", { ...pull, title: "Add files [render preview]" }, /render preview/);
    await refused("/pulls", { ...pull, title: "Add files [skip ci]" }, /skip ci/);
    await refused("/pulls", { ...pull, maintainer_can_modify: true }, /isn't a pull request/);
    await refused("/pulls", { ...pull, draft: false, auto_merge: true }, /isn't a pull request/);
    await write().post("/pulls", pull);
    assert.deepEqual(sent[0]?.body, pull);
  });

  test("a blob is base64, and nothing else", async () => {
    await refused("/git/blobs", { content: "plain text", encoding: "utf-8" }, /isn't a blob/);
    await refused("/git/blobs", { content: "not base64!", encoding: "base64" }, /isn't a blob/);
    await write().post("/git/blobs", { content: Buffer.from([0, 1, 2]).toString("base64"), encoding: "base64" });
    assert.equal(sent.length, 1);
  });

  test("guardWrite returns only what it checked", () => {
    const body = guardWrite(record, scope, "/git/refs", { ref: "refs/heads/mixos/install/app-files", sha: SHA });
    assert.deepEqual(body, { ref: "refs/heads/mixos/install/app-files", sha: SHA });
  });
});

/* ── a MixOS update's scope: one ref at one commit, and one pull request ─── */

describe("what a MixOS update may write", () => {
  const only: WriteScope = { refOnly: { branch: "mixos/update-v0.5.0", sha: SHA } };
  const update = () => linkedRepository(record, "write", "ghs_test", only);
  const ref = { ref: "refs/heads/mixos/update-v0.5.0", sha: SHA };
  const pull = { title: "Update MixOS to v0.5.0 [skip preview]", head: "mixos/update-v0.5.0", base: "main", body: "x" };

  test("no blob, tree or commit: the commit is upstream's", async () => {
    await refused("/git/blobs", { content: "eA==", encoding: "base64" }, /writes no blob, tree or commit/, update());
    await refused("/git/trees", tree([file("apps/files/a")]), /writes no blob, tree or commit/, update());
    await refused("/git/commits", { message: "Update", tree: SHA, parents: [SHA2] }, /writes no blob, tree or commit/, update());
    for (const suffix of ["/merges", "/merge-upstream", "/pulls/1/merge", "/git/tags", ""]) {
      await refused(suffix, ref, /writes no blob, tree or commit/, update());
    }
  });

  test("the one ref the scope names, at the one commit, and no other", async () => {
    await refused("/git/refs", { ref: "refs/heads/mixos/update-v0.5.1", sha: SHA }, /creates refs\/heads\/mixos\/update-v0\.5\.0 only/, update());
    await refused("/git/refs", { ref: "refs/heads/mixos/install/app-files", sha: SHA }, /creates refs\/heads\/mixos\/update-v0\.5\.0 only/, update());
    await refused("/git/refs", { ref: "refs/heads/main", sha: SHA }, /creates refs\/heads\/mixos\/update-v0\.5\.0 only/, update());
    await refused("/git/refs", { ref: "refs/tags/v0.5.0", sha: SHA }, /creates refs\/heads\/mixos\/update-v0\.5\.0 only/, update());
    await refused("/git/refs", { ref: ref.ref, sha: SHA2 }, /release's commit only/, update());
    await refused("/git/refs", { ...ref, force: true }, /isn't a ref/, update());
    await update().post("/git/refs", ref);
    assert.deepEqual(sent, [{ url: "https://api.github.com/repos/acme/mixos/git/refs", method: "POST", body: ref }]);
  });

  test("a pull request from that branch into the default branch, with a clean title", async () => {
    await refused("/pulls", { ...pull, head: "mixos/install/app-files" }, /comes from mixos\/update-v0\.5\.0 only/, update());
    await refused("/pulls", { ...pull, head: "mixos/update-v0.5.1" }, /comes from mixos\/update-v0\.5\.0 only/, update());
    await refused("/pulls", { ...pull, base: "release" }, /default branch only/, update());
    await refused("/pulls", { ...pull, title: "Update [skip ci]" }, /skip ci/, update());
    await refused("/pulls", { ...pull, title: "Update [render preview]" }, /render preview/, update());
    await refused("/pulls", { ...pull, title: "Update\nMixOS" }, /one line/, update());
    await refused("/pulls", { ...pull, draft: true }, /isn't a pull request/, update());
    await update().post("/pulls", pull);
    assert.deepEqual(sent[0]?.body, pull);
  });

  test("each of the two writes goes once", async () => {
    const repo = update();
    await repo.post("/git/refs", ref);
    await assert.rejects(repo.post("/git/refs", ref), /once/);
    await repo.post("/pulls", pull);
    await assert.rejects(repo.post("/pulls", pull), /once/);
    assert.deepEqual(sent.map((s) => s.url.replace("https://api.github.com/repos/acme/mixos", "")), ["/git/refs", "/pulls"]);
  });

  test("the scope itself is checked: an update branch at a commit, never the default branch", async () => {
    for (const bad of [
      { refOnly: { branch: "mixos/update/app-files", sha: SHA } },
      { refOnly: { branch: "mixos/update-v0.5", sha: SHA } },
      { refOnly: { branch: "mixos/update-v01.5.0", sha: SHA } },
      { refOnly: { branch: "mixos/install/app-files", sha: SHA } },
      { refOnly: { branch: "main", sha: SHA } },
      { refOnly: { branch: "mixos/update-v0.5.0", sha: "main" } },
      { refOnly: { branch: "mixos/update-v0.5.0", sha: SHA.slice(0, 39) } },
    ] as WriteScope[]) {
      await refused("/git/refs", ref, /isn't an update branch at a commit/, linkedRepository(record, "write", "t", bad));
    }
    const mixosDefault = linkedRepository({ ...record, defaultBranch: "mixos/update-v0.5.0" }, "write", "t", only);
    await refused("/git/refs", ref, /default branch/, mixosDefault);
    assert.equal(isUpdateBranch("mixos/update-v0.5.0-rc.1"), true);
    assert.equal(isUpdateBranch("mixos/update-0.5.0"), false);
  });
});
