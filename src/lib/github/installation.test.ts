/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The installation checks, and the tokens, against the fake GitHub
 * (./fake-github.ts) standing in for `fetch`. No database: the App's session is
 * built from a key the fake made.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GitHubError } from "./api";
import { FakeGitHub } from "./fake-github";
import {
  countRepositories,
  judgeInstallation,
  mintRepositoryToken,
  readInstallation,
  type AppSession,
} from "./installation";
import { appJwt, keyFingerprint, parsePrivateKey } from "./jwt";
import { APP_PERMISSIONS, TOKEN_SHAPES } from "./manifest";
import { linkedRepository, readBranchRules, readBranchRulesOrNone } from "./repository";
import type { GitHubRepository, Installation } from "./schemas";
import type { AppRecord, RepositoryRecord } from "./store";

const realFetch = globalThis.fetch;
let fake: FakeGitHub;
let session: AppSession;

function sessionFor(fakeApp: { id: number; slug: string; name: string; owner: { id: number; login: string; type: "User" | "Organization" } }, pem: string): AppSession {
  const key = parsePrivateKey(pem);
  const app: AppRecord = {
    id: fakeApp.id,
    slug: fakeApp.slug,
    name: fakeApp.name,
    owner: { id: fakeApp.owner.id, login: fakeApp.owner.login, type: fakeApp.owner.type },
    keyFingerprint: keyFingerprint(key),
    recordedAt: new Date().toISOString(),
  };
  return { app, jwt: appJwt(app.id, key) };
}

beforeEach(() => {
  fake = new FakeGitHub();
  globalThis.fetch = fake.fetch;
  const { app, pem } = fake.createApp("acme", "MixOS Test", { ...APP_PERMISSIONS });
  session = sessionFor(app, pem);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const repo = (id: number, owner = "acme", name = `r${id}`): GitHubRepository => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  owner: { id: 9001, login: owner },
  private: true,
  fork: false,
  default_branch: "main",
});

describe("judgeInstallation", () => {
  const app = (): AppRecord => session.app;
  const installation = (over: Partial<Installation> = {}): Installation => ({
    id: 1,
    app_id: session.app.id,
    account: { id: 9001, login: "acme", type: "User" },
    repository_selection: "selected",
    permissions: { ...APP_PERMISSIONS },
    suspended_at: null,
    ...over,
  });

  test("one chosen repository, the linked one, within the App's permissions: fine", () => {
    const verdict = judgeInstallation(app(), installation(), { total: 1, repositories: [repo(501)] }, 501);
    assert.equal(verdict.ok, true);
    assert.equal(judgeInstallation(app(), installation(), { total: 1, repositories: [repo(501)] }, null).ok, true);
  });

  test("each widening is named", () => {
    const cases: [Installation, { total: number; repositories: GitHubRepository[] }, number | null, string][] = [
      [installation({ repository_selection: "all" }), { total: 1, repositories: [repo(501)] }, 501, "all-repositories"],
      [installation(), { total: 2, repositories: [repo(501), repo(502)] }, 501, "more-than-one-repository"],
      [installation(), { total: 3, repositories: [repo(501), repo(502)] }, 501, "more-than-one-repository"],
      [installation(), { total: 0, repositories: [] }, 501, "repository-changed"],
      [installation(), { total: 1, repositories: [repo(502)] }, 501, "repository-changed"],
      [installation(), { total: 1, repositories: [repo(1345491436, "mixoshq", "mixos")] }, null, "upstream"],
      // Upstream is reported as upstream, even where it is also "changed".
      [installation(), { total: 1, repositories: [repo(1345491436, "mixoshq", "mixos")] }, 501, "upstream"],
      [installation({ permissions: { ...APP_PERMISSIONS, workflows: "write" } }), { total: 1, repositories: [repo(501)] }, 501, "permissions-widened"],
      [installation({ permissions: { ...APP_PERMISSIONS, checks: "write" } }), { total: 1, repositories: [repo(501)] }, 501, "permissions-widened"],
      [installation({ account: { id: 1, login: "someone", type: "User" } }), { total: 1, repositories: [repo(501)] }, 501, "another-account"],
      [installation({ app_id: 1 }), { total: 1, repositories: [repo(501)] }, 501, "another-account"],
    ];
    for (const [inst, listing, linked, problem] of cases) {
      const verdict = judgeInstallation(app(), inst, listing, linked);
      assert.equal(verdict.ok, false, problem);
      if (!verdict.ok) assert.equal(verdict.problem, problem);
    }
  });

  test("fewer permissions than the App's is not a widening", () => {
    const narrower = installation({ permissions: { contents: "read", metadata: "read" } });
    assert.equal(judgeInstallation(app(), narrower, { total: 1, repositories: [repo(501)] }, 501).ok, true);
  });
});

describe("tokens", () => {
  test("the count comes from a metadata-only token over the whole installation, revoked straight after", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos", "acme/website"] });
    const listing = await countRepositories(session, installed.id);
    assert.equal(listing.total, 2);
    const mint = fake.requests.find((r) => r.path.endsWith("/access_tokens"));
    assert.deepEqual(mint?.body, { permissions: { metadata: "read" } });
    assert.deepEqual(fake.calls(), [
      `POST /app/installations/${installed.id}/access_tokens`,
      "GET /installation/repositories",
      "DELETE /installation/token",
    ]);
    assert.ok([...fake.tokens.values()].every((t) => t.revoked));
  });

  test("an operation's token is narrowed to the linked repository's id, in the shape asked for", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos", "acme/website"] });
    for (const shape of ["read", "write"] as const) {
      fake.requests.length = 0;
      const token = await mintRepositoryToken(session, installed.id, 501, shape);
      assert.deepEqual(fake.requests[0].body, { repository_ids: [501], permissions: TOKEN_SHAPES[shape] });
      const held = fake.tokens.get(token);
      assert.deepEqual(held?.repositoryIds, [501]);
      assert.deepEqual(held?.permissions, { ...TOKEN_SHAPES[shape], metadata: "read" });
    }
  });

  test("a token GitHub didn't narrow, or granted more than asked, is revoked and not used", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos"] });
    for (const tamper of [
      (body: Record<string, unknown>) => ({ ...body, repositories: undefined }),
      (body: Record<string, unknown>) => ({ ...body, repositories: [{ id: 501 }, { id: 502 }] }),
      (body: Record<string, unknown>) => ({ ...body, permissions: { ...(body.permissions as object), workflows: "write" } }),
    ]) {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (!String(input).endsWith("/access_tokens")) return res;
        return Response.json(tamper((await res.json()) as Record<string, unknown>), { status: res.status });
      }) as typeof fetch;
      await assert.rejects(mintRepositoryToken(session, installed.id, 501, "read"), (err: unknown) => err instanceof GitHubError && err.failure === "malformed");
      const minted = [...fake.tokens.values()].at(-1);
      assert.equal(minted?.revoked, true);
    }
  });

  test("a repository outside the installation can't be asked for", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos"] });
    await assert.rejects(mintRepositoryToken(session, installed.id, 502, "read"), (err: unknown) => err instanceof GitHubError && err.status === 422);
  });

  test("a narrowed read token reads the repository and its branch rules, and can't write", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos"] });
    const record: RepositoryRecord = { id: 501, owner: "acme", name: "mixos", defaultBranch: "main", private: true, fork: true, parent: null };
    const token = await mintRepositoryToken(session, installed.id, 501, "read");
    const linked = linkedRepository(record, "read", token);
    assert.deepEqual(await readBranchRules(linked), { branch: "main", pullRequest: true, rules: ["deletion", "pull_request"] });
    await assert.rejects(linked.post("/git/refs", {}), (err: unknown) => err instanceof GitHubError && err.failure === "path");
    assert.ok(!JSON.stringify(linked).includes(token), "the token isn't a property of the repository object");
    const inst = await readInstallation(session, installed.id);
    assert.equal(inst.repository_selection, "selected");
  });

  test("rules GitHub won't show (403 or 404) read as none, with the status; anything else still fails", async () => {
    const installed = fake.install(session.app.id, { selection: "selected", repositories: ["acme/mixos"] });
    const record: RepositoryRecord = { id: 501, owner: "acme", name: "mixos", defaultBranch: "main", private: true, fork: true, parent: null };
    const token = await mintRepositoryToken(session, installed.id, 501, "read");
    const linked = linkedRepository(record, "read", token);
    for (const status of [403, 404]) {
      fake.failures.set("GET /repos/acme/mixos/rules", status);
      assert.deepEqual(await readBranchRulesOrNone(linked), { branch: "main", pullRequest: false, rules: [], unreadStatus: status });
    }
    fake.failures.set("GET /repos/acme/mixos/rules", 500);
    await assert.rejects(readBranchRulesOrNone(linked), (err: unknown) => err instanceof GitHubError && err.status === 500);
    fake.failures.clear();
  });
});
