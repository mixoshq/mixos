/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stand-in for the parts of GitHub the link uses, for the tests and for a
 * local end-to-end run. Nothing in the app imports it.
 *
 * It answers as `https://api.github.com` and `https://github.com` do for these
 * calls, from an in-memory world of accounts, repositories, Apps,
 * installations and tokens:
 *
 *   web   POST /settings/apps/new, POST /organizations/{org}/settings/apps/new
 *         GET  /apps/{slug}/installations/new
 *   api   POST /app-manifests/{code}/conversions
 *         GET  /app, GET /app/installations, GET|DELETE /app/installations/{id}
 *         POST /app/installations/{id}/access_tokens
 *         GET  /installation/repositories, DELETE /installation/token
 *         GET  /repos/{owner}/{repo}, GET /repos/{owner}/{repo}/rules/branches/{branch}
 *   and, for proposals and the Apps page, under /repos/{owner}/{repo}:
 *         GET  /contents/{path}?ref=, GET /git/ref/heads/{branch}, POST /git/refs
 *         GET|POST /git/commits, POST /git/blobs, GET|POST /git/trees
 *         GET|POST /pulls, GET /commits/{ref}/check-runs, GET /commits/{ref}/status
 *
 * Each repository has a small git object store: blobs, trees and commits with
 * git's own ids, and its branches. Nothing merges: no endpoint here would, and
 * a test can look in `requests` for any attempt.
 *
 * JWTs are checked as GitHub checks them: RS256, signed by one of the App's
 * keys, `iss` the App's id, at most ten minutes long. Tokens carry the
 * permissions and repositories they were minted for, and an endpoint answers
 * only within them. Everything secret it hands out or is shown (keys, tokens,
 * JWTs, the webhook and OAuth secrets) is kept in `secrets`, so a test can look
 * for any of it where it mustn't be.
 *
 * In a test, pass `fake.fetch` as `globalThis.fetch`. For a browser run,
 * `listen()` serves the API under `/api`, the web pages at the root, and a few
 * controls under `/__control` that a test drives the world with.
 */

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import http from "node:http";

export interface FakeAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
}

export interface FakeRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  fork: boolean;
  defaultBranch: string;
  parent: { id: number; fullName: string } | null;
  /** The ruleset rules that apply, per branch. */
  rules: Record<string, string[]>;
  /** Earlier names, which answer with a redirect, as GitHub's do. */
  formerNames: string[];
  /** Its objects and branches: made empty, with the default branch at a first commit. */
  git: FakeGit;
  pulls: FakePull[];
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  /** The App's bot, `<slug>[bot]`, or a person. */
  author: { login: string; type: "Bot" | "User" };
  state: "open" | "closed";
  createdAt: number;
  updatedAt: number;
}

/** A tree entry as git stores it. */
interface FakeTreeEntry {
  name: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

/** A file at a path, flattened out of a tree. */
interface FakeFile {
  mode: string;
  sha: string;
}

/**
 * A repository's objects, with git's ids (blob and tree ids are exactly
 * git's; a commit's is a hash of what it holds), and its branches.
 */
export class FakeGit {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, FakeTreeEntry[]>();
  readonly commits = new Map<
    string,
    { tree: string; parents: string[]; message: string; author: string; at: number }
  >();
  /** Branch name → commit. */
  readonly branches = new Map<string, string>();
  private counter = 0;

  putBlob(data: Buffer): string {
    const sha = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
    this.blobs.set(sha, data);
    return sha;
  }

  putTree(entries: FakeTreeEntry[]): string {
    const sorted = [...entries].sort((a, b) =>
      Buffer.compare(Buffer.from(a.type === "tree" ? `${a.name}/` : a.name), Buffer.from(b.type === "tree" ? `${b.name}/` : b.name)),
    );
    const body = Buffer.concat(
      sorted.flatMap((e) => [Buffer.from(`${e.type === "tree" ? "40000" : e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex")]),
    );
    const sha = createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
    this.trees.set(sha, sorted);
    return sha;
  }

  putCommit(tree: string, parents: string[], message: string, author: string, at: number): string {
    const sha = createHash("sha1")
      .update(JSON.stringify({ tree, parents, message, author, at, n: this.counter++ }))
      .digest("hex");
    this.commits.set(sha, { tree, parents, message, author, at });
    return sha;
  }

  /** Every file under a tree, by path. */
  files(tree: string, prefix = ""): Map<string, FakeFile> {
    const out = new Map<string, FakeFile>();
    for (const entry of this.trees.get(tree) ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === "tree") for (const [p, f] of this.files(entry.sha, path)) out.set(p, f);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
    return out;
  }

  /** The tree that holds `files`, folders made as their paths need them. */
  build(files: Map<string, FakeFile>): string {
    type Folder = Map<string, FakeFile | Folder>;
    const root: Folder = new Map();
    for (const [path, file] of files) {
      const names = path.split("/");
      let folder = root;
      for (const name of names.slice(0, -1)) {
        let next = folder.get(name);
        if (!(next instanceof Map)) {
          next = new Map();
          folder.set(name, next);
        }
        folder = next;
      }
      folder.set(names[names.length - 1], file);
    }
    const write = (folder: Folder): string =>
      this.putTree(
        [...folder.entries()].map(([name, value]) =>
          value instanceof Map
            ? { name, mode: "040000", type: "tree" as const, sha: write(value) }
            : { name, mode: value.mode, type: "blob" as const, sha: value.sha },
        ),
      );
    return write(root);
  }

  /** The entry at `path` in a tree, or null. */
  at(tree: string, path: string): FakeTreeEntry | { type: "tree"; sha: string; name: string; mode: string } | null {
    if (path === "") return { type: "tree", sha: tree, name: "", mode: "040000" };
    let current: string = tree;
    const names = path.split("/");
    for (let i = 0; i < names.length; i++) {
      const entry = (this.trees.get(current) ?? []).find((e) => e.name === names[i]);
      if (!entry) return null;
      if (i === names.length - 1) return entry;
      if (entry.type !== "tree") return null;
      current = entry.sha;
    }
    return null;
  }

  /**
   * Commit `changes` on `branch`, from its head or from nothing: each path to
   * its text, or to null to delete it. Returns the new commit.
   */
  commit(branch: string, changes: Record<string, string | null>, message: string, author: string, at: number): string {
    const head = this.branches.get(branch);
    const files = head ? this.files(this.commits.get(head)!.tree) : new Map<string, FakeFile>();
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, { mode: "100644", sha: this.putBlob(Buffer.from(text, "utf8")) });
    }
    const sha = this.putCommit(this.build(files), head ? [head] : [], message, author, at);
    this.branches.set(branch, sha);
    return sha;
  }

  /** A branch name or a commit id, as a commit, or null. */
  resolve(ref: string): string | null {
    if (this.branches.has(ref)) return this.branches.get(ref)!;
    return this.commits.has(ref) ? ref : null;
  }
}

export interface FakeApp {
  id: number;
  slug: string;
  name: string;
  owner: FakeAccount;
  permissions: Record<string, string>;
  events: string[];
  setupUrl: string;
  /** Public keys, by fingerprint. */
  keys: Map<string, KeyObject>;
}

export interface FakeInstallation {
  id: number;
  appId: number;
  account: FakeAccount;
  selection: "all" | "selected";
  repositoryIds: number[];
  permissions: Record<string, string>;
  suspended: boolean;
}

interface FakeToken {
  installationId: number;
  permissions: Record<string, string>;
  /** Null: every repository the installation covers. */
  repositoryIds: number[] | null;
  revoked: boolean;
  expiresAt: number;
}

export interface FakeRequest {
  host: "api" | "web";
  method: string;
  path: string;
  auth: "none" | "jwt" | "token" | "other";
  body: unknown;
}

/** GitHub's fingerprint for a key: SHA-256 over the public key's DER, base64. */
export function fingerprintOf(key: KeyObject): string {
  const der = (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

/** A fresh RSA key, as GitHub hands one out: PKCS#1 PEM. */
export function newPrivateKeyPem(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: privateKey.export({ type: "pkcs1", format: "pem" }) as string, publicKey };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { message: "Not Found" });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

export class FakeGitHub {
  readonly accounts = new Map<string, FakeAccount>();
  readonly repositories = new Map<number, FakeRepository>();
  readonly apps = new Map<number, FakeApp>();
  readonly installations = new Map<number, FakeInstallation>();
  readonly tokens = new Map<string, FakeToken>();
  readonly requests: FakeRequest[] = [];
  /** Every secret handed out or shown, to look for where it mustn't be. */
  readonly secrets = new Set<string>();
  /** The manifests posted to the web pages, as posted. */
  readonly manifests: unknown[] = [];
  /** Statuses to answer instead, by "METHOD /path-prefix". */
  readonly failures = new Map<string, number>();
  /** Who is signed in on the web pages. */
  user = "acme";
  /** What the next installation from the web page covers. */
  nextInstall: { selection: "all" | "selected"; repositories: string[] } = {
    selection: "selected",
    repositories: ["acme/mixos"],
  };
  now: () => number = () => Date.now();
  /** Check runs and commit statuses, by commit. */
  readonly checks = new Map<string, { runs: { name: string; status: string; conclusion: string | null }[]; statuses: { context: string; state: string }[] }>();

  private readonly codes = new Map<string, { manifest: Record<string, unknown>; owner: FakeAccount; at: number; used: boolean }>();
  private nextId = 7000;

  constructor() {
    this.addAccount({ id: 9001, login: "acme", type: "User" });
    this.addAccount({ id: 9002, login: "acme-org", type: "Organization" });
    this.addAccount({ id: 9003, login: "mixoshq", type: "Organization" });
    this.addRepository({
      id: 1345491436,
      owner: "mixoshq",
      name: "mixos",
      private: true,
      fork: false,
      defaultBranch: "main",
      parent: null,
      rules: { main: ["pull_request", "deletion"] },
    });
    this.addRepository({
      id: 501,
      owner: "acme",
      name: "mixos",
      private: true,
      fork: true,
      defaultBranch: "main",
      parent: { id: 1345491436, fullName: "mixoshq/mixos" },
      rules: { main: ["deletion", "pull_request"] },
    });
    this.addRepository({
      id: 502,
      owner: "acme",
      name: "website",
      private: false,
      fork: false,
      defaultBranch: "main",
      parent: null,
      rules: {},
    });
    this.addRepository({
      id: 601,
      owner: "acme-org",
      name: "mixos",
      private: true,
      fork: false,
      defaultBranch: "trunk",
      parent: null,
      rules: {},
    });
  }

  addAccount(account: FakeAccount): void {
    this.accounts.set(account.login, account);
  }

  addRepository(
    repository: Omit<FakeRepository, "formerNames" | "git" | "pulls"> & { formerNames?: string[]; files?: Record<string, string> },
  ): FakeRepository {
    const { files, ...rest } = repository;
    const repo: FakeRepository = { formerNames: [], ...rest, git: new FakeGit(), pulls: [] };
    repo.git.commit(repo.defaultBranch, files ?? { "README.md": `# ${repo.name}\n` }, "Initial commit", repo.owner, this.now());
    this.repositories.set(repo.id, repo);
    return repo;
  }

  /** Commit files to a branch, as someone pushing would: each path to its text, or null to delete it. */
  push(repositoryId: number, branch: string, changes: Record<string, string | null>, author = "someone"): string {
    const repo = this.repositories.get(repositoryId);
    if (!repo) throw new Error(`no repository ${repositoryId}`);
    const sha = repo.git.commit(branch, changes, `Change ${Object.keys(changes).join(", ")}`, author, this.now());
    for (const pull of repo.pulls) if (pull.head === branch && pull.state === "open") pull.updatedAt = this.now();
    return sha;
  }

  /** A branch at another branch's head, as a person might make one. */
  branch(repositoryId: number, name: string, from?: string): void {
    const repo = this.repositories.get(repositoryId);
    if (!repo) throw new Error(`no repository ${repositoryId}`);
    repo.git.branches.set(name, repo.git.resolve(from ?? repo.defaultBranch)!);
  }

  /** The files on a branch, as text, by path. */
  filesOn(repositoryId: number, branch: string): Record<string, string> {
    const repo = this.repositories.get(repositoryId);
    const head = repo?.git.branches.get(branch);
    if (!repo || !head) return {};
    const out: Record<string, string> = {};
    for (const [path, file] of repo.git.files(repo.git.commits.get(head)!.tree)) {
      out[path] = repo.git.blobs.get(file.sha)!.toString("utf8");
    }
    return out;
  }

  repository(fullName: string): FakeRepository | undefined {
    return [...this.repositories.values()].find((r) => `${r.owner}/${r.name}` === fullName);
  }

  /** Rename a repository, keeping its id; the old name redirects. */
  rename(id: number, owner: string, name: string): void {
    const repo = this.repositories.get(id);
    if (!repo) throw new Error(`no repository ${id}`);
    repo.formerNames.push(`${repo.owner}/${repo.name}`);
    repo.owner = owner;
    repo.name = name;
  }

  /** An App created some other way, such as someone else's: its PEM is returned. */
  createApp(owner: string, name: string, permissions: Record<string, string>): { app: FakeApp; pem: string } {
    const account = this.accounts.get(owner);
    if (!account) throw new Error(`no account ${owner}`);
    const { pem, publicKey } = newPrivateKeyPem();
    const app: FakeApp = {
      id: this.nextId++,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      owner: account,
      permissions: { ...permissions },
      events: [],
      setupUrl: "https://elsewhere.invalid/setup",
      keys: new Map([[fingerprintOf(publicKey), publicKey]]),
    };
    this.apps.set(app.id, app);
    this.secrets.add(pem);
    return { app, pem };
  }

  /** As the App's settings page does it: a new private key, whose PEM is returned. */
  addKey(appId: number): { pem: string; fingerprint: string } {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`no App ${appId}`);
    const { pem, publicKey } = newPrivateKeyPem();
    const fingerprint = fingerprintOf(publicKey);
    app.keys.set(fingerprint, publicKey);
    this.secrets.add(pem);
    return { pem, fingerprint };
  }

  deleteKey(appId: number, fingerprint: string): void {
    this.apps.get(appId)?.keys.delete(fingerprint);
  }

  /** Install an App, as its installation page does. */
  install(appId: number, choice: { selection: "all" | "selected"; repositories: string[] }): FakeInstallation {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`no App ${appId}`);
    const installation: FakeInstallation = {
      id: this.nextId++,
      appId,
      account: app.owner,
      selection: choice.selection,
      repositoryIds: choice.repositories.map((name) => {
        const repo = this.repository(name);
        if (!repo) throw new Error(`no repository ${name}`);
        return repo.id;
      }),
      permissions: { ...app.permissions },
      suspended: false,
    };
    this.installations.set(installation.id, installation);
    return installation;
  }

  /** Change an installation, as its settings page does. */
  changeInstallation(
    id: number,
    change: Partial<Pick<FakeInstallation, "selection" | "permissions" | "suspended">> & { repositories?: string[] },
  ): void {
    const installation = this.installations.get(id);
    if (!installation) throw new Error(`no installation ${id}`);
    if (change.selection) installation.selection = change.selection;
    if (change.permissions) installation.permissions = change.permissions;
    if (change.suspended !== undefined) installation.suspended = change.suspended;
    if (change.repositories) {
      installation.repositoryIds = change.repositories.map((name) => {
        const repo = this.repository(name);
        if (!repo) throw new Error(`no repository ${name}`);
        return repo.id;
      });
    }
  }

  /** The repositories an installation reaches now. */
  private covered(installation: FakeInstallation): FakeRepository[] {
    if (installation.selection === "all") {
      return [...this.repositories.values()].filter((r) => r.owner === installation.account.login);
    }
    return installation.repositoryIds.map((id) => this.repositories.get(id)).filter((r): r is FakeRepository => !!r);
  }

  /** Requests to the API by method and path, without the query: "GET /app". */
  calls(): string[] {
    return this.requests.filter((r) => r.host === "api").map((r) => `${r.method} ${r.path.split("?")[0]}`);
  }

  /* ------------------------------------------------------------------------ */
  /*  As fetch                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Pass as `globalThis.fetch`. Anything but github.com and api.github.com is refused. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.redirect !== "manual") throw new Error(`the fake GitHub expects redirect: "manual" (${url.href})`);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const host = url.origin === "https://api.github.com" ? "api" : url.origin === "https://github.com" ? "web" : null;
    if (!host) throw new TypeError(`fetch failed: the fake GitHub doesn't answer ${url.origin}`);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    return this.handle(host, init?.method ?? "GET", `${url.pathname}${url.search}`, headers, body);
  };

  /** One request, from either host. */
  async handle(host: "api" | "web", method: string, pathAndQuery: string, headers: Headers, body: string): Promise<Response> {
    const authorization = headers.get("authorization");
    const auth: FakeRequest["auth"] = !authorization
      ? "none"
      : /^Bearer ghs_/.test(authorization)
        ? "token"
        : /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(authorization)
          ? "jwt"
          : "other";
    if (authorization) this.secrets.add(authorization.replace(/^Bearer /, ""));
    let parsedBody: unknown = body;
    if (headers.get("content-type")?.includes("application/json") && body) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    this.requests.push({ host, method, path: pathAndQuery, auth, body: parsedBody });

    const url = new URL(pathAndQuery, "https://fake.invalid");
    for (const [prefix, status] of this.failures) {
      const [failMethod, failPath] = prefix.split(" ");
      if (failMethod === method && url.pathname.startsWith(failPath)) {
        return json(status, { message: "Injected failure" });
      }
    }
    return host === "api"
      ? this.api(method, url, authorization, parsedBody)
      : this.web(method, url, body);
  }

  /* ------------------------------------------------------------------------ */
  /*  github.com                                                                */
  /* ------------------------------------------------------------------------ */

  private web(method: string, url: URL, body: string): Response {
    const create = /^\/(?:organizations\/([^/]+)\/)?settings\/apps\/new$/.exec(url.pathname);
    if (create && method === "POST") {
      const manifestText = new URLSearchParams(body).get("manifest");
      if (!manifestText) return new Response("No manifest", { status: 422 });
      const manifest = JSON.parse(manifestText) as Record<string, unknown>;
      this.manifests.push(manifest);
      const owner = this.accounts.get(create[1] ? decodeURIComponent(create[1]) : this.user);
      if (!owner) return new Response("No such account", { status: 404 });
      const code = randomBytes(20).toString("hex");
      // Exchangeable for the App's key within the hour, so a secret too.
      this.secrets.add(code);
      this.codes.set(code, { manifest, owner, at: this.now(), used: false });
      const target = new URL(String(manifest.redirect_url));
      target.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state !== null) target.searchParams.set("state", state);
      return redirect(target.href);
    }

    const installPage = /^\/apps\/([^/]+)\/installations\/new$/.exec(url.pathname);
    if (installPage && method === "GET") {
      const app = [...this.apps.values()].find((a) => a.slug === installPage[1]);
      if (!app) return new Response("Not Found", { status: 404 });
      const installation = this.install(app.id, this.nextInstall);
      const target = new URL(app.setupUrl);
      target.searchParams.set("installation_id", String(installation.id));
      target.searchParams.set("setup_action", "install");
      return redirect(target.href);
    }
    return new Response("Not Found", { status: 404 });
  }

  /* ------------------------------------------------------------------------ */
  /*  api.github.com                                                            */
  /* ------------------------------------------------------------------------ */

  /** The App a JWT speaks for, or the 401 GitHub would answer. */
  private appFor(authorization: string | null): FakeApp | Response {
    const refuse = (message: string) => json(401, { message });
    const jwt = authorization?.replace(/^Bearer /, "") ?? "";
    const parts = jwt.split(".");
    if (parts.length !== 3) return refuse("A JSON web token could not be decoded");
    let header: { alg?: string };
    let payload: { iss?: string | number; iat?: number; exp?: number };
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return refuse("A JSON web token could not be decoded");
    }
    if (header.alg !== "RS256") return refuse("A JSON web token could not be decoded");
    const app = this.apps.get(Number(payload.iss));
    if (!app) return refuse("Integration not found");
    const signed = [...app.keys.values()].some((key) =>
      verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url")),
    );
    if (!signed) return refuse("A JSON web token could not be decoded");
    const now = Math.floor(this.now() / 1000);
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return refuse("Missing 'issued at' or 'expiration time' claim");
    if (payload.iat > now + 60) return refuse("'Issued at' claim ('iat') must be an Integer representing a time in the past");
    if (payload.exp <= now) return refuse("'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires");
    if (payload.exp - payload.iat > 660) return refuse("'Expiration time' claim ('exp') is too far in the future");
    return app;
  }

  private tokenFor(authorization: string | null): FakeToken | Response {
    const token = this.tokens.get(authorization?.replace(/^Bearer /, "") ?? "");
    if (!token || token.revoked || token.expiresAt <= this.now()) return json(401, { message: "Bad credentials" });
    return token;
  }

  private repositoryJson(repo: FakeRepository) {
    return {
      id: repo.id,
      node_id: `R_${repo.id}`,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: this.accounts.get(repo.owner)?.id ?? 1, type: this.accounts.get(repo.owner)?.type ?? "User" },
      private: repo.private,
      fork: repo.fork,
      default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      ...(repo.parent ? { parent: { id: repo.parent.id, full_name: repo.parent.fullName }, source: { id: repo.parent.id, full_name: repo.parent.fullName } } : {}),
    };
  }

  private installationJson(installation: FakeInstallation) {
    return {
      id: installation.id,
      app_id: installation.appId,
      app_slug: this.apps.get(installation.appId)?.slug,
      account: { login: installation.account.login, id: installation.account.id, type: installation.account.type },
      target_type: installation.account.type,
      repository_selection: installation.selection,
      permissions: installation.permissions,
      events: [],
      suspended_at: installation.suspended ? new Date(this.now()).toISOString() : null,
    };
  }

  private api(method: string, url: URL, authorization: string | null, body: unknown): Response {
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if ((m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path)) && method === "POST") {
      const code = this.codes.get(decodeURIComponent(m[1]));
      if (!code || code.used || this.now() - code.at > 60 * 60 * 1000) return notFound();
      code.used = true;
      const manifest = code.manifest;
      // GitHub's App names are unique, and its page makes the admin pick
      // another: here, a suffix does.
      const base = String(manifest.name);
      let name = base;
      for (let n = 2; [...this.apps.values()].some((a) => a.name === name); n++) name = `${base} ${n}`;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
      const { pem, publicKey } = newPrivateKeyPem();
      const app: FakeApp = {
        id: this.nextId++,
        slug,
        name,
        owner: code.owner,
        permissions: { ...(manifest.default_permissions as Record<string, string>) },
        events: [...((manifest.default_events as string[]) ?? [])],
        setupUrl: String(manifest.setup_url),
        keys: new Map([[fingerprintOf(publicKey), publicKey]]),
      };
      this.apps.set(app.id, app);
      const webhookSecret = randomBytes(20).toString("hex");
      const clientSecret = randomBytes(20).toString("hex");
      for (const secret of [pem, webhookSecret, clientSecret]) this.secrets.add(secret);
      return json(201, {
        id: app.id,
        slug: app.slug,
        node_id: `A_${app.id}`,
        owner: { login: app.owner.login, id: app.owner.id, type: app.owner.type },
        name: app.name,
        description: manifest.description,
        external_url: manifest.url,
        html_url: `https://github.com/apps/${app.slug}`,
        created_at: new Date(this.now()).toISOString(),
        updated_at: new Date(this.now()).toISOString(),
        permissions: app.permissions,
        events: app.events,
        installations_count: 0,
        client_id: `Iv1.${randomBytes(8).toString("hex")}`,
        client_secret: clientSecret,
        webhook_secret: webhookSecret,
        pem,
      });
    }

    if (path === "/app" && method === "GET") {
      const app = this.appFor(authorization);
      if (app instanceof Response) return app;
      return json(200, {
        id: app.id,
        slug: app.slug,
        name: app.name,
        owner: { login: app.owner.login, id: app.owner.id, type: app.owner.type },
        permissions: app.permissions,
        events: app.events,
      });
    }

    if (path === "/app/installations" && method === "GET") {
      const app = this.appFor(authorization);
      if (app instanceof Response) return app;
      return json(
        200,
        [...this.installations.values()].filter((i) => i.appId === app.id).map((i) => this.installationJson(i)),
      );
    }

    if ((m = /^\/app\/installations\/(\d+)$/.exec(path))) {
      const app = this.appFor(authorization);
      if (app instanceof Response) return app;
      const installation = this.installations.get(Number(m[1]));
      if (!installation || installation.appId !== app.id) return notFound();
      if (method === "GET") return json(200, this.installationJson(installation));
      if (method === "DELETE") {
        this.installations.delete(installation.id);
        for (const token of this.tokens.values()) if (token.installationId === installation.id) token.revoked = true;
        return new Response(null, { status: 204 });
      }
    }

    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === "POST") {
      const app = this.appFor(authorization);
      if (app instanceof Response) return app;
      const installation = this.installations.get(Number(m[1]));
      if (!installation || installation.appId !== app.id) return notFound();
      if (installation.suspended) return json(403, { message: "This installation has been suspended" });
      const request = (body ?? {}) as { permissions?: Record<string, string>; repository_ids?: number[] };
      const asked = request.permissions ?? installation.permissions;
      for (const [name, level] of Object.entries(asked)) {
        const granted = installation.permissions[name];
        if (!granted || (level === "write" && granted !== "write")) {
          return json(422, { message: "The permissions requested are not granted to this installation." });
        }
      }
      const covered = this.covered(installation).map((r) => r.id);
      let repositoryIds: number[] | null = null;
      if (request.repository_ids) {
        if (request.repository_ids.some((id) => !covered.includes(id))) {
          return json(422, {
            message: "There is at least one repository that does not exist or is not accessible to the parent installation.",
          });
        }
        repositoryIds = [...request.repository_ids];
      }
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      const expiresAt = this.now() + 60 * 60 * 1000;
      this.tokens.set(token, { installationId: installation.id, permissions: { ...asked, metadata: "read" }, repositoryIds, revoked: false, expiresAt });
      this.secrets.add(token);
      return json(201, {
        token,
        expires_at: new Date(expiresAt).toISOString(),
        permissions: { ...asked, metadata: "read" },
        repository_selection: repositoryIds ? "selected" : installation.selection,
        ...(repositoryIds
          ? { repositories: repositoryIds.map((id) => this.repositoryJson(this.repositories.get(id)!)) }
          : {}),
      });
    }

    if (path === "/installation/repositories" && method === "GET") {
      const token = this.tokenFor(authorization);
      if (token instanceof Response) return token;
      const installation = this.installations.get(token.installationId);
      if (!installation) return json(401, { message: "Bad credentials" });
      const visible = this.covered(installation).filter((r) => token.repositoryIds === null || token.repositoryIds.includes(r.id));
      const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30") || 30, 100);
      return json(200, {
        total_count: visible.length,
        repository_selection: installation.selection,
        repositories: visible.slice(0, perPage).map((r) => this.repositoryJson(r)),
      });
    }

    if (path === "/installation/token" && method === "DELETE") {
      const token = this.tokenFor(authorization);
      if (token instanceof Response) return token;
      token.revoked = true;
      return new Response(null, { status: 204 });
    }

    if ((m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path))) {
      const token = this.tokenFor(authorization);
      if (token instanceof Response) return token;
      const fullName = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      const moved = [...this.repositories.values()].find((r) => r.formerNames.includes(fullName));
      if (moved) {
        return new Response(JSON.stringify({ message: "Moved Permanently", url: `https://api.github.com/repositories/${moved.id}` }), {
          status: method === "GET" ? 301 : 307,
          headers: { location: `https://api.github.com/repositories/${moved.id}${m[3] ?? ""}` },
        });
      }
      const repo = this.repository(fullName);
      const installation = this.installations.get(token.installationId);
      const reachable =
        repo &&
        installation &&
        this.covered(installation).some((r) => r.id === repo.id) &&
        (token.repositoryIds === null || token.repositoryIds.includes(repo.id));
      if (!repo || !reachable) return notFound();
      return this.repositoryApi(method, repo, token, m[3] ?? "", url.searchParams, body);
    }

    return notFound();
  }

  /** A 403 unless the token holds `permission` at `level`, as GitHub answers an App. */
  private needs(token: FakeToken, permission: string, level: "read" | "write"): Response | null {
    const granted = token.permissions[permission];
    if (!granted || (level === "write" && granted !== "write")) {
      return json(403, { message: "Resource not accessible by integration" });
    }
    return null;
  }

  /** The App whose token this is, as its bot signs. */
  private botFor(token: FakeToken): { login: string; type: "Bot" } {
    const app = this.apps.get(this.installations.get(token.installationId)?.appId ?? -1);
    return { login: `${app?.slug ?? "app"}[bot]`, type: "Bot" };
  }

  private pullJson(repo: FakeRepository, pull: FakePull) {
    const head = repo.git.branches.get(pull.head) ?? "0".repeat(40);
    const base = repo.git.branches.get(pull.base) ?? "0".repeat(40);
    const repoJson = this.repositoryJson(repo);
    return {
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      user: pull.author,
      head: { ref: pull.head, sha: head, repo: repoJson, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: base, repo: repoJson, label: `${repo.owner}:${pull.base}` },
      created_at: new Date(pull.createdAt).toISOString(),
      updated_at: new Date(pull.updatedAt).toISOString(),
      draft: false,
    };
  }

  private commitJson(git: FakeGit, sha: string) {
    const commit = git.commits.get(sha)!;
    const person = { name: commit.author, email: `${commit.author}@users.noreply.github.com`, date: new Date(commit.at).toISOString() };
    return {
      sha,
      tree: { sha: commit.tree },
      parents: commit.parents.map((p) => ({ sha: p })),
      message: commit.message,
      author: person,
      committer: person,
    };
  }

  private treeJson(git: FakeGit, sha: string) {
    return {
      sha,
      truncated: false,
      tree: (git.trees.get(sha) ?? []).map((e) => ({
        path: e.name,
        mode: e.mode,
        type: e.type,
        sha: e.sha,
        ...(e.type === "blob" ? { size: git.blobs.get(e.sha)?.length ?? 0 } : {}),
      })),
    };
  }

  /** Under /repos/{owner}/{repo}, for a token that reaches the repository. */
  private repositoryApi(
    method: string,
    repo: FakeRepository,
    token: FakeToken,
    rest: string,
    query: URLSearchParams,
    body: unknown,
  ): Response {
    const git = repo.git;
    const input = (body ?? {}) as Record<string, unknown>;
    const unprocessable = (message: string) => json(422, { message });
    let m: RegExpExecArray | null;

    if (method === "GET" && rest === "") return json(200, this.repositoryJson(repo));

    if (method === "GET" && (m = /^\/rules\/branches\/(.+)$/.exec(rest))) {
      const branch = decodeURIComponent(m[1]);
      return json(
        200,
        (repo.rules[branch] ?? []).map((type, i) => ({
          type,
          ruleset_source_type: "Repository",
          ruleset_source: `${repo.owner}/${repo.name}`,
          ruleset_id: 100 + i,
        })),
      );
    }

    if (method === "GET" && (m = /^\/contents(?:\/(.*))?$/.exec(rest))) {
      const denied = this.needs(token, "contents", "read");
      if (denied) return denied;
      const path = (m[1] ?? "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
      const commit = git.resolve(query.get("ref") ?? repo.defaultBranch);
      if (!commit) return json(404, { message: `No commit found for the ref ${query.get("ref")}` });
      const entry = git.at(git.commits.get(commit)!.tree, path);
      if (!entry) return notFound();
      if (entry.type === "tree") {
        return json(
          200,
          (git.trees.get(entry.sha) ?? []).map((e) => ({
            name: e.name,
            path: path ? `${path}/${e.name}` : e.name,
            type: e.type === "tree" ? "dir" : e.mode === "120000" ? "symlink" : "file",
            sha: e.sha,
            size: e.type === "blob" ? (git.blobs.get(e.sha)?.length ?? 0) : 0,
          })),
        );
      }
      const data = git.blobs.get(entry.sha) ?? Buffer.alloc(0);
      if (entry.mode === "120000") return json(200, { type: "symlink", target: data.toString("utf8"), name: entry.name, path, sha: entry.sha, size: data.length });
      return json(200, {
        type: "file",
        encoding: "base64",
        // GitHub wraps the base64 at 60 characters.
        content: (data.toString("base64").match(/.{1,60}/g) ?? []).join("\n"),
        size: data.length,
        name: entry.name,
        path,
        sha: entry.sha,
      });
    }

    if (method === "GET" && (m = /^\/git\/ref\/(.+)$/.exec(rest))) {
      const denied = this.needs(token, "contents", "read");
      if (denied) return denied;
      const ref = m[1].split("/").map(decodeURIComponent).join("/");
      const branch = ref.startsWith("heads/") ? ref.slice("heads/".length) : null;
      const sha = branch === null ? undefined : git.branches.get(branch);
      if (!sha) return notFound();
      return json(200, { ref: `refs/${ref}`, object: { sha, type: "commit" } });
    }

    if (method === "POST" && rest === "/git/refs") {
      const denied = this.needs(token, "contents", "write");
      if (denied) return denied;
      const ref = String(input.ref ?? "");
      const sha = String(input.sha ?? "");
      if (!/^refs\/heads\/.+/.test(ref)) return unprocessable("Reference name must start with 'refs/' and have at least two slashes.");
      const name = ref.slice("refs/heads/".length);
      if (git.branches.has(name)) return unprocessable("Reference already exists");
      if ([...git.branches.keys()].some((b) => b.startsWith(`${name}/`) || name.startsWith(`${b}/`))) {
        return unprocessable(`Reference cannot be created: ${name} would collide with an existing reference`);
      }
      if (!git.commits.has(sha)) return unprocessable("Object does not exist");
      git.branches.set(name, sha);
      return json(201, { ref, object: { sha, type: "commit" } });
    }

    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const denied = this.needs(token, "contents", "read");
      if (denied) return denied;
      return git.commits.has(m[1]) ? json(200, this.commitJson(git, m[1])) : notFound();
    }

    if (method === "POST" && rest === "/git/commits") {
      const denied = this.needs(token, "contents", "write");
      if (denied) return denied;
      const tree = String(input.tree ?? "");
      const parents = Array.isArray(input.parents) ? input.parents.map(String) : [];
      if (!git.trees.has(tree)) return unprocessable("Tree SHA does not exist");
      if (parents.some((p) => !git.commits.has(p))) return unprocessable("Parent SHA does not exist or is not a commit object");
      const sha = git.putCommit(tree, parents, String(input.message ?? ""), this.botFor(token).login, this.now());
      return json(201, this.commitJson(git, sha));
    }

    if (method === "POST" && rest === "/git/blobs") {
      const denied = this.needs(token, "contents", "write");
      if (denied) return denied;
      const encoding = input.encoding === "base64" ? "base64" : "utf8";
      const sha = git.putBlob(Buffer.from(String(input.content ?? ""), encoding));
      return json(201, { sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${sha}` });
    }

    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
      const denied = this.needs(token, "contents", "read");
      if (denied) return denied;
      return git.trees.has(m[1]) ? json(200, this.treeJson(git, m[1])) : notFound();
    }

    if (method === "POST" && rest === "/git/trees") {
      const denied = this.needs(token, "contents", "write");
      if (denied) return denied;
      const files = input.base_tree === undefined ? new Map<string, FakeFile>() : null;
      const base = typeof input.base_tree === "string" ? input.base_tree : null;
      if (base !== null && !git.trees.has(base)) return unprocessable("base_tree is not a valid tree oid");
      const tree = files ?? git.files(base!);
      const entries = Array.isArray(input.tree) ? (input.tree as Record<string, unknown>[]) : [];
      for (const entry of entries) {
        const path = String(entry.path ?? "");
        if (!path || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
          return unprocessable("tree.path contains a malformed path component");
        }
        const mode = String(entry.mode ?? "");
        if (!["100644", "100755", "040000", "160000", "120000"].includes(mode)) return unprocessable("tree.mode is not valid");
        if (entry.sha === null) {
          tree.delete(path);
        } else if (typeof entry.content === "string") {
          tree.set(path, { mode, sha: git.putBlob(Buffer.from(entry.content, "utf8")) });
        } else if (typeof entry.sha === "string" && git.blobs.has(entry.sha)) {
          tree.set(path, { mode, sha: entry.sha });
        } else {
          return unprocessable("tree.sha is not a valid blob");
        }
      }
      return json(201, this.treeJson(git, git.build(tree)));
    }

    if (method === "GET" && rest === "/pulls") {
      const denied = this.needs(token, "pull_requests", "read");
      if (denied) return denied;
      const state = query.get("state") ?? "open";
      const pulls = repo.pulls
        .filter((p) => state === "all" || p.state === state)
        .sort((a, b) => b.number - a.number)
        .slice(0, Math.min(Number(query.get("per_page") ?? "30") || 30, 100));
      return json(200, pulls.map((p) => this.pullJson(repo, p)));
    }

    if (method === "POST" && rest === "/pulls") {
      const denied = this.needs(token, "pull_requests", "write");
      if (denied) return denied;
      const head = String(input.head ?? "");
      const base = String(input.base ?? "");
      if (!git.branches.has(head) || !git.branches.has(base)) return unprocessable("Validation Failed: head or base is not a branch");
      if (git.branches.get(head) === git.branches.get(base)) return unprocessable(`No commits between ${base} and ${head}`);
      if (repo.pulls.some((p) => p.state === "open" && p.head === head && p.base === base)) {
        return unprocessable(`A pull request already exists for ${repo.owner}:${head}.`);
      }
      const pull: FakePull = {
        number: repo.pulls.length + 1,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        head,
        base,
        author: this.botFor(token),
        state: "open",
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      repo.pulls.push(pull);
      return json(201, this.pullJson(repo, pull));
    }

    if (method === "GET" && (m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
      const denied = this.needs(token, "checks", "read");
      if (denied) return denied;
      const sha = git.resolve(decodeURIComponent(m[1]));
      if (!sha) return notFound();
      const runs = this.checks.get(sha)?.runs ?? [];
      return json(200, {
        total_count: runs.length,
        check_runs: runs.map((r, i) => ({ id: i + 1, head_sha: sha, name: r.name, status: r.status, conclusion: r.conclusion })),
      });
    }

    if (method === "GET" && (m = /^\/commits\/([^/]+)\/status$/.exec(rest))) {
      const denied = this.needs(token, "statuses", "read");
      if (denied) return denied;
      const sha = git.resolve(decodeURIComponent(m[1]));
      if (!sha) return notFound();
      const statuses = this.checks.get(sha)?.statuses ?? [];
      const state = statuses.some((s) => s.state === "failure" || s.state === "error")
        ? "failure"
        : statuses.length === 0 || statuses.some((s) => s.state === "pending")
          ? "pending"
          : "success";
      return json(200, { sha, state, total_count: statuses.length, statuses });
    }

    return notFound();
  }

  /* ------------------------------------------------------------------------ */
  /*  For a browser run                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Serve the API under `/api`, the web pages at the root, and controls under
   * `/__control`, on `host:port`.
   */
  listen(port: number, hostname = "127.0.0.1"): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const path = req.url ?? "/";
      let response: Response;
      try {
        if (path.startsWith("/__control/")) response = this.control(req.method ?? "GET", path, body);
        else if (path.startsWith("/api/")) response = await this.handle("api", req.method ?? "GET", path.slice(4), headers, body);
        else response = await this.handle("web", req.method ?? "GET", path, headers, body);
      } catch (err) {
        response = json(500, { message: err instanceof Error ? err.message : String(err) });
      }
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    return new Promise((resolve) => server.listen(port, hostname, () => resolve(server)));
  }

  private control(method: string, path: string, body: string): Response {
    const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;
    if (path === "/__control/state" && method === "GET") {
      return json(200, {
        apps: [...this.apps.values()].map((a) => ({ id: a.id, slug: a.slug, name: a.name, owner: a.owner.login, keys: [...a.keys.keys()], permissions: a.permissions, events: a.events })),
        installations: [...this.installations.values()].map((i) => ({ ...i, account: i.account.login })),
        requests: this.requests,
        manifests: this.manifests,
        secrets: [...this.secrets],
        tokens: [...this.tokens.entries()].map(([token, t]) => ({ token, ...t })),
        repositories: [...this.repositories.values()].map((r) => ({
          id: r.id,
          fullName: `${r.owner}/${r.name}`,
          branches: Object.fromEntries(r.git.branches),
          pulls: r.pulls.map((p) => this.pullJson(r, p)),
        })),
      });
    }
    if ((m = /^\/__control\/repositories\/(\d+)\/read$/.exec(path)) && method === "POST") {
      return json(200, this.filesOn(Number(m[1]), String(input.branch ?? "main")));
    }
    if ((m = /^\/__control\/repositories\/(\d+)\/files$/.exec(path)) && method === "POST") {
      const repo = this.repositories.get(Number(m[1]));
      if (!repo) return notFound();
      const branch = String(input.branch ?? repo.defaultBranch);
      return json(200, { sha: this.push(repo.id, branch, input.files as Record<string, string | null>, String(input.author ?? "someone")) });
    }
    if ((m = /^\/__control\/repositories\/(\d+)\/branches$/.exec(path)) && method === "POST") {
      this.branch(Number(m[1]), String(input.name), input.from ? String(input.from) : undefined);
      return json(200, { ok: true });
    }
    if ((m = /^\/__control\/repositories\/(\d+)\/checks$/.exec(path)) && method === "POST") {
      const repo = this.repositories.get(Number(m[1]));
      const sha = repo?.git.resolve(String(input.ref ?? ""));
      if (!repo || !sha) return notFound();
      this.checks.set(sha, {
        runs: (input.runs as { name: string; status: string; conclusion: string | null }[]) ?? [],
        statuses: (input.statuses as { context: string; state: string }[]) ?? [],
      });
      return json(200, { sha });
    }
    if (path === "/__control/next-install" && method === "POST") {
      this.nextInstall = input as FakeGitHub["nextInstall"];
      return json(200, this.nextInstall);
    }
    if ((m = /^\/__control\/installations\/(\d+)$/.exec(path)) && method === "POST") {
      this.changeInstallation(Number(m[1]), input as Parameters<FakeGitHub["changeInstallation"]>[1]);
      return json(200, this.installationJson(this.installations.get(Number(m[1]))!));
    }
    if ((m = /^\/__control\/apps\/(\d+)\/keys$/.exec(path)) && method === "POST") {
      return json(200, this.addKey(Number(m[1])));
    }
    if (path === "/__control/stray-key" && method === "POST") {
      const { pem } = newPrivateKeyPem();
      this.secrets.add(pem);
      return json(200, { pem });
    }
    if ((m = /^\/__control\/repositories\/(\d+)\/rules$/.exec(path)) && method === "POST") {
      const repo = this.repositories.get(Number(m[1]));
      if (!repo) return notFound();
      repo.rules = input as Record<string, string[]>;
      return json(200, repo.rules);
    }
    if (path === "/__control/failures" && method === "POST") {
      this.failures.clear();
      for (const [prefix, status] of Object.entries(input)) this.failures.set(prefix, Number(status));
      return json(200, Object.fromEntries(this.failures));
    }
    if (path === "/__control/user" && method === "POST") {
      this.user = String(input.login);
      return json(200, { user: this.user });
    }
    return notFound();
  }
}
