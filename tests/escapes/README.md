# Escape tests

Each test here is an app, or an app's query, trying to reach past what MixOS
says it may reach, and failing. They are the checks behind the claims in
[the threat model](../../docs/threat-model.md) and
[the security architecture](../../docs/security-architecture.md): if a claim
there has no test here, or in the code next to what it describes, it isn't
checked.

| File | What it tries |
|---|---|
| [`context-reach.integration.test.ts`](context-reach.integration.test.ts) | Widening its own manifest (egress, connectors, global), asking another app's service as someone else, reading a connector's credentials, and finding a pool, `process` or a secret anywhere reachable from `context`. |
| [`app-database.integration.test.ts`](app-database.integration.test.ts) | SQL that reaches a platform table, another app's table or a platform function; SQL written to escape the app's role, or to leave code behind; a census of everything each app's role can use; writes through a read-only client; wrong roles under load on one pool. |
| [`known-limits.integration.test.ts`](known-limits.integration.test.ts) | What code in the server process can still reach: the platform's pool on the global object, and one connector's code reading another's credentials. Pinned, as below. |
| [`catalogue.test.ts`](catalogue.test.ts) | That the catalogue holds together, and a route served past its tiers. |

## The catalogue

[`catalogue.ts`](catalogue.ts) lists every known escape: what it tries, what
happens on each host tier (refused at build, refused at runtime, contained, or
a known limit), the row of the threat model it backs, and the tests that show
it, here or next to the code they try. Many of those tests live beside what
they test, in `src/` and `scripts/`; the catalogue is the one list.
`catalogue.test.ts` checks that every test it names exists, that every row it
names is in the threat model, and that every label's escapes
(`src/lib/apps/labels.ts`) are cases in it, so none of the three can change
without the others.

## A test that passes while a limit holds

Some tests pin a limit: they pass because something the docs admit to is still
true. `app-database.integration.test.ts` has one: the platform's own login,
which the server process holds, reaches every app's tables.
`known-limits.integration.test.ts` has two more. The catalogue marks each as
`known-limit`. If one of these
fails, the boundary got stronger. Update the docs that state the limit, then
the test.

## Running them

They run with the rest, `npm test`, and need a Postgres they may create and
drop databases and roles on. Without `MIXOS_TEST_DATABASE_URL` they skip:

```sh
docker run -d --rm --name escapes -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
MIXOS_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
  npx tsx --test "tests/escapes/*.test.ts"
```

CI runs them against Postgres 17. `app-database.integration.test.ts` also
passes against 13, 14, 15 and 16.

## Adding one

Write the attempt the way hostile code would, against the real thing (a real
database, the real context builders), and assert it fails. Say in the file's
header what it tries. A new security property lands with its test here.
