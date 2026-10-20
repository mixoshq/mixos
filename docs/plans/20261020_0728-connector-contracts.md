# Connector contracts

## Context

A connector is the layer between a provider's API and the apps that use it. The
goal is that building an app never means changing a connector: a connector
changes when the provider's API changes, and only then.

Half of that holds already. Authentication, credentials, timeouts, retries,
pagination, the failure categories and telemetry belong to the platform, so an
app never touches them and building one never changes them.

The other half does not. What a connector offers is sized to the first app that
used it, in four ways, and the only real connector so far shows all four:

1. **Methods.** `google-sheets` has `getSpreadsheet` and `getValues`, exactly the
   two calls `key-numbers` makes. An app that reads several ranges in one call
   has to add a method first.
2. **Results.** `getSpreadsheet` asks Google for the title, URL and tab names
   only, and `getValues` turns every cell into a string. An app that wants a
   tab's row count, or a number as a number, has to change the connector.
3. **Access.** The scope is fixed in each release: read-only. The first app that
   writes needs a new connector release, and an install that already connected
   stays read-only until an admin reconnects.
4. **Versions.** `app.json` names connectors by name alone, so an app cannot say
   which version it was built against, and nothing protects it from a release
   that removes a method it calls.

The docs leaned the same way: "What you write is the methods your apps actually
call", and "Project the fields you actually map… tying the projection to the
mapper".

## Decisions

| Decision | Choice |
| --- | --- |
| The rule | A connector mirrors the provider's API. The app decides what to do with it. |
| Coverage | Every operation on each resource the connector touches, one method each, named as the provider names it |
| One method, one operation | Each declared method names the provider operation it calls, in `operation`. Required, and no two methods may name the same one: a variant is an option, not a second method |
| Results | The provider's records in full, typed. Field selection and formatting are optional parameters that default to everything |
| Who allows writes | The admin of each install, per connector: **Allow changes**, off by default |
| Where that is kept | `platform_settings`, key `connector.writable.<name>`, like the on/off switch: a publisher can't set it |
| Scopes for writes | `auth.scopes[].requested: "write"`, requested only once changes are allowed |
| What an app declares | Each `connectors` and `optionalConnectors` entry is `{ "name", "version", "access"? }`. `"access": "write"` to call a method that changes data |
| What an app can call | A connector's declared methods and nothing else: never `request()` or another member reached around the declaration. A method declared `mutates` runs only when the app declared `"write"` **and** the admin allowed changes |
| A connector's version | `version` in `connector.json`, `X.Y.Z`, **required** |
| An app's version | `version` on every entry, **required**: the connector version it was built against. Any later release with the same major version satisfies it |
| The contract | Within a major version a connector only adds. Removing a method, or making a read into a write, needs a new major version |
| Where it is checked | The build, Registry install and update (the staged checks), the pre-commit hook (against `HEAD`), and mixos.org at publish (against the previous release) |
| Google Sheets | 1.0.0: the Sheets API's spreadsheets and values operations, typed, writes behind Allow changes. Key Numbers declares 1.0.0 |

MixOS has no installs to carry forward, so none of this keeps a second, older
form: an entry is an object, every version is required, and nothing falls back.

**Why the admin, and why per install.** Minimum scopes stay the rule, but the
decision moves to where the facts are: the person who runs this install, who
can see which of its apps need to change data. A connector can then ship its
write methods once, and the first app that writes needs an admin's yes, not a
new connector release.

**Why an app's `"write"` is enforced, not advisory.** An app reaches the
environment and the network by declaration and no other way (apps/AGENTS.md,
invariant 25). Connector writes join that list: an admin can read, from an app's
manifest, whether it can change data in Google Sheets, and the answer is true.
MCP tools already work this way, through `readOnlyConnector()`, and the same
narrowing serves both.

**Why only declared methods.** `request()` is protected to the compiler and
reachable with `as any` at runtime, where it sends any verb to any path with the
connector's credential. Handed the whole instance, an app could step around
every declaration on this page. Narrowed to the declared methods, the manifest
is the whole of what an app can do with a connector.

**Why `operation`.** "One method per provider operation" is a rule a reviewer
can only check by reading the code. Named in the manifest, it is a list anyone
can read against the provider's reference, the build can hold to one method per
operation, and a method shaped for one app, which calls two operations or none,
has nothing to name.

**Why a version floor and not a range.** `requiresMixOS` is a floor for the
reason `src/lib/platform/version-floor.ts` gives: a range grammar promises npm's
semantics, which is much more than the field needs. An app names the version it
was built against; the contract says what a later release may change. So
`"version": "1.2.0"` means 1.2.0 or any later 1.x release, and 2.0.0 does not
satisfy it. Major version 0 is no exception: it is a major version like any other.

**Why both versions are required.** A version an app can't name protects
nothing: an app that named none could be handed any release, including the one
that removed what it calls.

### What changes for an extension

- `connector.json` needs `version`, and `operation` on each declared method.
- An `app.json` entry is `{ "name", "version" }`, with `"access": "write"` where
  the app changes data. A bare name fails the build.
- A connector's write methods are off on an install until its admin allows
  changes.

## Structure

### Manifests (`scripts/manifest-schemas.ts`, the types)

- `connector.json`: `version` (`X.Y.Z`, required). `auth.scopes[].requested`
  becomes `true | false | "write"`. A `"write"` scope requires a method declared
  `mutates`, or nothing could ever use it.
- `app.json`: each entry in `connectors` and `optionalConnectors` is a string or
  `{ name, version?, access? }`. A name may appear once across both lists.
- The generated `AppManifest` keeps `connectors` and `optionalConnectors` as
  names, so every reader of them is unchanged, and adds
  `connectorRequirements`: `{ name, optional, access, version }` for each.
- `src/lib/connectors/requirements.ts`, pure: reading entries in either form,
  parsing and comparing versions, and comparing two manifests' method lists.

### The build (`scripts/generate-project-registry.ts`)

- `validateConnectorRequirements(apps, connectors)`: an app's `version` must be
  satisfied by the connector in this checkout, and `"write"` must name a
  connector that has a method declared `mutates`. A connector that isn't in the
  checkout is not an error here: the activation gate reports it, as it does now.
- The main build throws on a failure, as `validateUserScopedUsage` does. The
  staged checks report it as a problem: an app needing a newer connector is
  refused at install, and a connector release that would break an installed app
  is refused at install and update.

### Runtime

- `src/lib/connectors/writable.ts`: which connectors may change data, read once
  per context like the switch, and failing closed: unreadable means read-only.
  The admin wrapper records `connector.allow-changes` and
  `connector.disallow-changes`.
- `loadTenantConnectors` (`src/lib/apps/context.ts`): a connector is handed over
  whole when the app declared `"write"` and changes are allowed. Otherwise it is
  narrowed by the generalized `readOnlyConnector()`. The refusal says which of
  the two is missing: the app's declaration, a bug for its developer, or the
  admin's setting, a `forbidden` ConnectorError with an admin hint.
- `HttpConnector.allowWrites(instance)`, platform-only like `bindUserGrant`, so
  a client-credentials token is minted with the write scopes only when changes
  are allowed.
- OAuth: `requestedScopes(policy, { writes })`. The sealed flow state carries
  `writes`, so the callback's `grantedScope()` fallback and the scope verdicts
  are read against what was actually requested.

### Admin

- Configure dialog: a **Changes** step before Connect, for a connector with a
  method declared `mutates`: Read only, or Allow changes. It lists the methods
  that change data and the apps that need them. Allowing changes on an OAuth
  connector that is already connected says to reconnect, and the activation
  gate asks for it until the grant holds the write scopes.
- Scopes tab: a `"write"` scope reads "Requested once changes are allowed".
- Activation gate (`connector-gates.ts`): a new state, `read-only`, for a
  required connector whose app needs `"write"` while changes aren't allowed.
- App dialog: each connector's access and version.
- Delete data clears `connector.writable.<name>`. A connector replaced by a
  different one under the same name loses it, as it loses the switch.

### Install, update and remove

- `src/lib/repository/review.ts` and `remove.ts` read entries in either form.
  Review says which connectors an app changes data in, and which version it needs.

### Pre-commit

- `scripts/check-connector-contract.ts`, from `.githooks/pre-commit`: for each
  staged `connector.json` of a local connector, refuse a version that goes
  backwards, and a removed method or a read made into a write without a new
  major version. Additions need no bump per commit; a release's version is
  mixos.org's to check.

### mixos.org

- Read entries in either form wherever an app's connectors are listed or turned
  into permissions, and list "changes data in" for an entry with `"write"`.
- Refuse a connector release without a `version`, and hold one to the contract
  against the release before it: a higher version, a new minor version for an
  added method, a new major version for a removed one.

### Docs and rules

- `connectors/AGENTS.md`: the rule, coverage and results as invariants; `version`
  and the contract; `requested: "write"`.
- `apps/AGENTS.md` and `/mixos app`: declare `"write"` and `version`; a missing
  operation is added to the connector as a mirror of the provider, never shaped
  for the app.
- `/mixos connector`: the plan lists the provider's operations for the resources
  in scope, and maps each to a method.
- `docs/connectors/` (architecture, implementation, usage in apps, scopes,
  registry UX), `docs/apps/connectors.md`, both templates, and `WHATS-NEW.md`.

## Verification

1. `npm run registry`, `npm run typecheck`, `npm test`, `npm run lint`,
   `npm run verify:connectors`.
2. Unit tests: entries in either form; version parsing and the floor; the
   contract comparison; the narrowing and its two refusals; `requestedScopes`
   and `classifyGrant` with and without writes; the new gate state.
3. Generator: an app needing a newer connector fails the build and the staged
   check; a connector without `version` fails; `"write"` on a connector with no
   write method fails.
4. Dev server, as an admin: Google Sheets' Configure dialog with changes off
   and on, the Scopes tab, Key Numbers' dialog, and Key Numbers' routes.
