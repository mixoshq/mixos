# Security

MixOS is in alpha. Test it before you use it in production, and use it at
your own risk. It is still worth reporting what you find: this file says how,
and what an extension you install can do.

## Reporting a vulnerability

Please don't open a public issue, discussion or pull request for a
vulnerability. Report it privately on GitHub instead:
[**Report a vulnerability**](https://github.com/mixoshq/mixos/security/advisories/new).
Only the maintainers can read it.

Say what you found and how to reproduce it: the version or commit, how the
instance was hosted, the requests or steps, and what an attacker gains. A proof
of concept helps; anything that touches someone else's instance or data
doesn't, so test against an instance of your own.

The conversation stays in the advisory. When a fix is ready, it ships in a
release, and the advisory is published with it, crediting you unless you'd
rather it didn't.

## Which versions get fixes

While MixOS is in alpha, only the newest release gets security fixes. An
instance takes a fix by merging that release's tag (see
[Releases](README.md#releases)).

## What is in scope

- The platform: everything outside `apps/`, `connectors/` and `themes/`.
- What the core repository ships under those folders: the templates, Wall·E
  and the built-in themes.
- The hosting files (`Dockerfile`, `docker-compose.yml`, `render.yaml`,
  `railway.json`, `vercel.json`, `deploy/`) and the scripts that set up and
  release an instance.
- Installing from the Registry: a way to make an instance install, update or
  run code that mixos.org didn't sign, or that isn't the reviewed commit.

An extension someone else publishes is its author's code. Report a problem in
it to its own repository. If MixOS let that extension do something it should
have refused, that part is ours: report it here.

Not a vulnerability: the values in `.env.docker`. They are committed on purpose
for local development and are public. A way to make an instance that uses them
reachable from another machine is a vulnerability, though.

## What an installed extension can do

Apps and connectors run inside the MixOS server process. The platform gives an
app only what its manifest declares, through its `context`, and the build
refuses app code that reads the environment or imports anything outside an
allowlist. That check reads the code's syntax. It is not a sandbox: code written
to get around it can reach whatever the server can, including its keys and its
database.

So installing an app or a connector means trusting its author with the whole
instance. An app or a connector from the Registry waits, unregistered, until an
admin registers it: read what it will run first. The Registry checks that what lands on your disk is the signed,
reviewed commit. It doesn't make that code safe to run.

What MixOS protects against, and what's still exposed, is on one page in the
[threat model](docs/threat-model.md). The design, and the reasoning behind each
boundary, is in
[`docs/security-architecture.md`](docs/security-architecture.md). Sections 24
(environment containment) and 31 (installing from the Registry) cover the two
above.
