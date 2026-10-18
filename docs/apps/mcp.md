# MCP Tools (letting Claude read your app)

MixOS runs a single **MCP server** at `/api/mcp`. A user connects Claude to it
once, and from then on Claude can answer questions using data from MixOS apps —
"what closed this quarter, and which onboardings are in flight?"

Your app decides what it contributes. Declare **read-only tools** in `app.json`
and write a handler per tool. Nothing is exposed unless you opt in.

> This is the opposite direction from the [`anthropic` connector](connectors.md),
> which is MixOS calling *out* to Claude. Here Claude calls *in*.

## The model

A tool is reachable only where four independent gates overlap:

1. **Your app declares it** — `mcp` in `app.json`, handler on disk, validated at
   build time.
2. **An admin enabled it** — a switch per tool on the app's MCP tab
   (Administration → Apps → your app). **Every tool starts disabled**, including
   after an upgrade and after a rename, so shipping a tool is not the same as
   turning it on. A disabled tool is not listed, cannot be called, and an app
   with none enabled is left off the consent screen.
3. **The user consented to your app** for that client, on the MixOS consent screen.
4. **The user still has your app** — `hasAppGrant`, re-checked on every call.

Consent is a *ceiling*, the live grant is a *floor*. An admin revoking someone's
grant removes your tools immediately, without the user re-consenting; re-granting
never silently re-expands a consent they didn't give.

The connection **runs as the connecting user**, with your app's roles resolved.
It can never see something that user couldn't already see in your app.

## Declare a tool

```jsonc
// apps/my-app/app.json
"mcp": [
  {
    "name": "quarter-summary",          // → handler at mcp/quarter-summary.ts
    "description": "Closed-won ARR and deal count for the current quarter, with year-to-date team totals.",
    "hint": "Use for quarterly attainment, new ARR booked, or one rep's closed business.",
    "sources": ["monday"],
    "notCovered": "Open deals and forecast — see my-app__pipeline. Renewals, which live in another app's renewal tool."
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase-hyphenated. Exposed to clients as `<slug>__<name>`. |
| `description` | yes | Written **for a model**. See below — this is the whole product. |
| `hint` | no | *When* to reach for the tool, as a shape of question rather than a subject area. |
| `sources` | yes | Where the data comes from: connector slugs your app declares, or `"mixos"` for data that exists only in MixOS. The build rejects a slug you haven't declared. |
| `notCovered` | no | What a reader might expect and won't get. Strongly encouraged — see below. |

Those four strings are assembled into the one description a client sees:

```
[My App] Closed-won ARR and deal count for the current quarter, with year-to-date team totals.

Use for quarterly attainment, new ARR booked, or one rep's closed business.

Built from: monday.com — joined and cached in MixOS, scoped to what you can already
see there; that system's own connector holds the raw records.
Not covered: Open deals and forecast — see my-app__pipeline. Renewals, which live
in another app's renewal tool.
```

**Maximum 5 tools per app; aim for 2–3.** The build fails at 6. The client sees
one flat list pooled across every app the user consented to, and models degrade
badly as it grows. One tool that answers a question beats four that each return a
fragment.

### Descriptions are the product

`name`, `description`, and the derived input schema are the *only* things a model
sees when deciding whether to call you. A vague description means your tool never
gets called, or gets called for the wrong question. Say what it returns and when
to use it, in plain language:

- ✅ "Open deals in the monday.com Sales pipeline — total open ARR, deal count, and
  the largest deals with company, stage, close date, and next steps."
- ❌ "Returns pipeline data."

Review these as carefully as the code.

### Describe your data, don't claim a topic

Your tool does not appear alone. A client pools it into one flat list beside every
other server the user has connected — their monday.com, their Slack, their Drive —
and picks from that list. Most of those tools describe mechanics and stop:
*"searches CRM records with filters."* No claim on when to use it.

So when one tool in the list says **"Start here for any question about onboarding
status"**, it doesn't read as a capability, it reads as an instruction — and it
wins, including on the questions where the user's own monday.com connector held the
better answer. One sentence in one `app.json` quietly degrades every other
connector that user owns. That is why these are build failures, not review notes:

```
mcp.0.hint: contains "Start here" — it ranks this tool ahead of tools it cannot
see. A client reads this pooled with every other connected server's tools, so an
imperative claim here quietly outranks them.
```

Rejected outright: `start here`, `first stop`, `any … question`, `for all
questions`, `always use`, `prefer … over`, `the authoritative/canonical/only
source`, `before using any other`. The check is narrow on purpose — it catches
unconditional forms, not every soft topic claim. Staying inside it is not the same
as writing a well-bounded description.

The rewrite is almost always the same move: **swap the subject area for the data.**

| Instead of | Write |
|---|---|
| "Start here for any Voice-of-Customer question." | "Use to resolve a customer name to the mondayItemId and domain that the account-brief tool needs." |
| "Use for anything about bugs customers have reported." | "Use for the triage view of a customer-reported bug — priority, age, status, whether a fix has shipped." |
| "Use for questions about retention, GRR, NRR, churn, or expansion." | "Use when the answer is a headline number for a period rather than a per-account breakdown." |

The right-hand column still routes well. The difference is that it can *lose* — a
better-suited tool beats it, which is the property we want.

### `sources` and `notCovered` earn the claim

Dropping the topic claims is only half of it. Strip a description back to bare
mechanics and a model can no longer tell your joined, cached view apart from the
source system's own connector — so it reaches for raw monday.com search and gets a
worse answer than your app would have given. The two structured fields let you
keep the useful signal without asserting jurisdiction:

- **`sources`** names the upstream systems. Rendered as the `Built from:` line,
  which also tells the model those systems' own connectors hold the raw records.
  Entries must be connectors your app declares, or `"mixos"` for records that live
  only in MixOS. **Only list what the tool actually reads.** If your app
  declares `dock` but the MCP handler never calls it, `dock` is not a source —
  a provenance claim you don't honour is worse than one you never made.
- **`notCovered`** is the boundary. Prefer a concrete exclusion over a hedge, and
  name the tool that *does* cover it where one exists:
  - ✅ "Accounts with no call recordings ingested yet, which simply do not appear."
  - ✅ "Customers still onboarding — see `onboarding__list`."
  - ❌ "May be incomplete."

Cross-app pointers belong here rather than in `hint`: `hint` is about the question
you answer, `notCovered` is about the questions you don't.

## Write the handler

`apps/<slug>/mcp/<name>.ts`, with **two required exports**. The registry
generator refuses to build without both.

```ts
import { z } from "zod";
import type { McpToolContext } from "@/lib/hooks/types";

export const inputSchema = z.object({
  ownerName: z
    .string()
    .optional()
    .describe('Case-insensitive match on the deal owner, e.g. "Sam". Omit for the whole team.'),
  limit: z.number().int().min(1).max(200).optional()
    .describe("Maximum rows to return. Defaults to 50."),
});

export default async function quarterSummary(
  ctx: McpToolContext,
  input: z.infer<typeof inputSchema>,
) {
  // Authorize in YOUR OWN terms, exactly as an API route would.
  // Return a plain object.
}
```

`inputSchema` is converted to JSON Schema at request time — **`.describe()` every
field**, because those strings are what the model reads to work out how to call
you. Keep schemas to flat objects of primitives, enums, and optionals; anything
`z.toJSONSchema()` can't express gets the tool omitted from the list (with a
server-side log).

Input is validated before your handler runs. Validation failures go back to the
model as readable messages, and it will retry with corrected arguments.

### The context

```ts
interface McpToolContext {
  user: AppContextUser;                      // always present, never null
  connectors: Record<string, BaseConnector>; // incl. user-scoped (real identity)
  db: ReadOnlyScopedClient | null;           // reads only
  telemetry: TelemetryClient | null;
  services: ServicesClient | null;           // when your app declares `consumes`
  manifest: AppManifest;
  caller: { kind: "mcp"; clientId: string; clientName: string };
}
```

It's the same connectors, roles, and scoped data your own API routes get for this
user — deliberately, so there's no second authorization surface to keep in step —
narrowed to reads. No `notifications`, no `hooks`: a tool answers a question, it
does not act.

`ctx.caller.clientName` is the client's self-reported name. Display only —
never authorize on it.

## Read-only is enforced, not requested

| Layer | What it catches |
|---|---|
| **Type** | `ctx.db` has no `insert` / `update` / `upsert` / `delete`. Compile error. |
| **Runtime** | The scoped client is a Proxy that throws on those verbs, surviving `as any` and every `.select().eq()` hop. |
| **Imports** | No app code can import `@/lib/db*`, the App Services broker, or the context builder. The build refuses the app, and ESLint flags it in an editor. |
| **Connectors** | A tool can call only the methods a connector declares as reads. A method declared `mutates`, or one it doesn't declare at all (`request()` included), throws. |
| **App Services** | A provider reached through `ctx.services` runs read-only too: its `db` refuses writes and its connectors are narrowed the same way. |

**A connector declares which of its methods mutate** (`mutates: true` on a
method in its manifest), because the platform could not know otherwise. The MCP
context wraps `ctx.connectors` so that only the declared reads can be called —
so a write from a read-only tool is a runtime error, not a blocking review
finding somebody has to catch. Anything a connector doesn't declare is refused
as well, including the base class's `request()`: it is protected, but `as any` reaches it, and it sends
whatever verb it is given.

**A tool can't write by asking another app to.** When it calls
`ctx.services.request(...)`, the provider's handler gets a read-only `db` and
read-only connectors, and `ctx.caller.readOnly` is `true` so it can skip a write
it would normally make. A write it attempts anyway fails the request.

**The residue is honest and worth knowing.** The check trusts the declaration: a
method that writes but isn't declared `mutates` runs. So: declare your
connector's writes, and keep watching for side effects hiding inside a helper
you're reusing. If a route's builder fires a hook or writes an audit row on the
way past, the tool must call a variant that doesn't — firing a hook is a side
effect even when nothing in the tool's own code writes anything.

## Reuse, don't duplicate

Your tool and your UI must never disagree about the same number. Share the
builders:

```ts
// apps/my-app/mcp/quarter-summary.ts
import { currentQuarterRange, fetchClosedWonDeals } from "../api/_monday-deals";
```

If the logic lives inline in a route, lift it to `lib/server/` and have both call
it. When a shared builder only reads, type its deps as read-only so a tool can
use it — declare a `ReadOnlyBuilderDeps` type in your app's `lib/server/types.ts`
that takes `ReadOnlyScopedClient`. A full `ScopedClient` satisfies it, so your
existing route callers don't change.

## Shape the result for a model, not a widget

Return the facts; drop the presentation. Hex colors, RAG enums, embed URLs, and
Gantt date-trios cost context and mean nothing to a model. Start from the
view-model your UI renders and strip everything that only exists to be looked at.

- **Keep responses small.** Aim for tens of KB. There's a hard 1 MB cap; over it
  the call fails rather than truncating, because a truncated answer looks
  authoritative and is wrong.
- **Paginate explicitly, and say so.** Take a `limit`, and return
  `truncated: true` plus the full `totalMatched` when you cut the list. Compute
  aggregates over *everything matched*, before the limit — otherwise a model
  quotes a total that's quietly wrong.
- **Handle an unconfigured connector in words, not a status code.** There's no
  HTTP status here. Return `{ unavailable: true, reason: "..." }` explaining what
  an admin needs to do.
- **Return a next step when there is one.** A `list` tool should tell the model
  it can call the matching `detail` tool with an id from the list.

## Errors

The broker rejects with a code, delivered to the model as a readable tool result
(not a protocol error — that would be invisible to it and just abort the turn):

`NOT_FOUND` · `NOT_EXPOSED` · `NOT_CONSENTED` · `FORBIDDEN_USER` · `APP_UPDATING` ·
`NO_HANDLER` · `INVALID_INPUT` · `TIMEOUT` (30s) · `PAYLOAD_TOO_LARGE` (1 MB) ·
`TOOL_ERROR`

A tool an admin hasn't enabled answers `NOT_EXPOSED`, as a tool your app never
declared does, with the same message, after the same reads. Someone without your
app gets `FORBIDDEN_USER` whatever tool they name: the grant is checked first.

Your thrown errors become `TOOL_ERROR`, passed through `safeErrorMessage()`.
`APP_UPDATING` means your app's own migrations are behind this build: a call
answers "This app is being updated. Try again shortly.", and your tools are
left out of the tool list until the migrations are applied.

## What the operator sees

**The MCP tab** of your app's details dialog (Administration → Apps → your app →
**Details** → MCP) shows each tool with every field you wrote, and a switch.
Every tool starts off, so a tool you ship is reachable only once an admin has
read it and turned it on. The heading counts how many are on, and turning one
off stops its next call on every connection. If a different extension takes
your app's slug, the release step turns every tool off again: the switches were
turned on for the one before it.

Every tool call is recorded — **automatically, with no `telemetry` declaration
needed**. Being read by a model isn't something an app opts into, so an operator
never has to opt into seeing it. In **Administration → Analytics**:

- **Overview → MCP requests by app** — total tool calls per app for the range.
  Every app exposing tools is listed, so a `0` means "reachable by a model but
  never used", not "missing".
- **Select your app** — per-tool call counts (including declared-but-never-called
  tools), a daily trend, and which users were asking. Your app appears in the
  selector on the strength of its `mcp` block alone.

Use it to spot the two failure modes docs can't catch: a tool nobody calls
(usually a weak `description`), and a tool called far more than expected (usually
one that should have been narrower).

## What the user sees

- **`/account/mcp`** — the URL to paste into Claude, connected clients, what each
  can read, and a Disconnect button.
- **The consent screen** — one checkbox per app they can reach that has at
  least one enabled tool, showing your app's name, description, and every
  enabled tool's description.

Your descriptions appear here too. They're read by people as well as models.

## Verify

1. `npx tsx scripts/generate-project-registry.ts` — your tools appear. A missing
   handler, a missing `inputSchema`, a 6th tool, or a missing `description`
   aborts the build.
2. `npm run typecheck` and `npm run lint`.
3. Turn your tool on, on your app's MCP tab (Administration → Apps → Details →
   MCP). Every tool starts off, and a tool that is off isn't listed.
4. `npx @modelcontextprotocol/inspector` against `http://localhost:3000/api/mcp` —
   walks the whole OAuth flow, then lets you call your tool with real arguments.
   **Read what it returns as if you were the model.** Is it answerable? Is
   anything in there noise?
5. Connect a real client and ask the question your tool exists to answer.
