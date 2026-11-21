# Search (making your app findable from ⌘K)

MixOS has one search over everything a person can reach. The search icon in
the menu bar, or ⌘K (Ctrl+K off a Mac), opens a modal in the middle of the
screen. What the person types goes to one MixOS endpoint, `/api/search`, which
asks every app they have installed, in parallel, and shows the answers grouped
by app.

Your app takes part by declaring **what can be searched** in `app.json` and
writing **a handler per kind of object**. Nothing is searched unless you opt in.

## What a person sees

- **Results grouped by app**, in the order the person chose on
  **My Account → Search** (`/account/search`). Each kind of object shows its
  **top 5**, then **Show 10 more**, again and again until there are no more.
- **Arrow keys** move the highlight through every row; **Enter** opens a
  result (⌘/Ctrl+Enter in a new tab) or loads ten more; **Escape** closes.
- **An Apps group**: typing `cal` offers to open Calendar. MixOS provides it;
  your app is in it if it has pages.
- On the settings page a person can reorder apps, switch an app off, hide the
  menu-bar icon or turn off the shortcut. With both of those off, search isn't
  available to them at all.

A query shorter than 2 characters searches the Apps group only: one letter
matches everything.

## Declare what can be searched

```jsonc
// apps/my-app/app.json
"search": [
  {
    "name": "notes",                 // → handler at search/notes.ts
    "label": "Notes",                // the group heading, plural
    "icon": "notebook",              // optional Lucide name; defaults to the app's icon
    "fields": [                      // the properties searched, title first
      { "key": "title", "label": "Title" },
      { "key": "body", "label": "Body" }
    ],
    "link": "notes?id={id}"          // the page a result opens
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase-hyphenated, unique in the app. Names the handler file. |
| `label` | yes | What these objects are called, plural: "Notes", "Candidates". 40 characters or fewer. |
| `icon` | no | A Lucide name for this object's rows. Defaults to the app's `icon`. |
| `fields` | yes | 1 to 6 `{ key, label }`. `key` is the column or property; **the first is the title**, and a match there ranks above any other. |
| `link` | yes | Where a result opens: a path relative to `/apps/<slug>/`, then optionally a query string. See below. |

**At most 5 objects per app.** Every object is a query on every search a person
makes, for every app they hold.

### The link template

`link` names one of your app's pages, the way the menu bar names it, plus the
query string that says which record to show:

```
"notes?id={id}"                 → /apps/my-app/notes?id=n_123
"?id={id}"                      → /apps/my-app?id=n_123          (the root page)
"boards/cards?card={id}&board={board}"  → …?card=c_9&board=b_2   (`board` from params)
```

- **`{id}` is the result's `id`.** Any other `{key}` is filled from the
  result's `params`. A result missing a value its link needs is left out (and
  logged), because a row that opens the wrong page is worse than no row.
- **Placeholders go in the query string only.** App pages have literal paths —
  there is no `notes/[id]` — so the record arrives as a query parameter, which
  the page reads with `useSearchParams` ([App Shell](./app-shell.md)).
- **Every value is URL-encoded** by the platform, and the path is copied as
  written. Whatever a handler returns, a result can only ever open a page
  inside its own app.
- **The build checks the path is one of your pages.** `"link": "note?id={id}"`
  with only `pages/notes/Main.tsx` on disk fails the build, rather than sending
  every result to a not-found screen.

## Write the handler

`apps/<slug>/search/<name>.ts`, with a default export:

```ts
import { containsPattern, searchFields, type SearchInput } from "@/lib/apps/search";
import type { SearchContext } from "@/lib/hooks/types";

export default async function searchNotes(ctx: SearchContext, input: SearchInput) {
  const db = ctx.db!;
  return searchFields<{ id: string; title: string; body: string; updated_at: string }>({
    input,
    // Up to `take` rows where `field` contains the query, newest first.
    fetch: async (field, take) => {
      const { data, error } = await db
        .table("notes")
        .select("id, title, body, updated_at")
        .eq("owner_id", ctx.user.id) // only what this person may open
        .ilike(field, containsPattern(input.query))
        .order("updated_at", { ascending: false })
        .limit(take);
      if (error) throw error;
      return data;
    },
    toResult: (n) => ({ id: n.id, title: n.title, subtitle: n.body.slice(0, 120) }),
  });
}
```

### The input

```ts
interface SearchInput {
  query: string;    // trimmed, 2–100 characters
  fields: string[]; // your declared field keys, title first
  offset: number;   // 0, then 5, 15, 25…
  limit: number;    // return up to this many
}
```

`limit` is one more than the modal shows: that is how the platform knows
whether to offer **Show 10 more**. Return up to `limit` results, and no fewer
when there are that many.

### The result

```ts
interface SearchResult {
  id: string;                       // unique within the object; fills {id}
  title: string;                    // up to 200 characters
  subtitle?: string;                // up to 300: a snippet, a date, a status
  params?: Record<string, string>;  // the link's other {placeholders}
}
```

Longer strings are trimmed, not refused. A result without an `id` or `title`
is left out.

### Ranking: contains, title first

Every app ranks the same way, so results from six apps can sit in one modal
without one app's idea of "relevant" crowding out another's:

1. A result matches when **any declared field contains the query**, ignoring
   case.
2. **Matches in the first field come first**, then matches in the second that
   weren't already listed, and so on.
3. Within a field, **your query's order**: most recent first, for most data.

`searchFields()` does exactly this. The query builder has no `or()`, so it asks
`fetch` once per field, in order, and merges the rows without repeating one.
Each field is asked for `offset + limit` rows, which is always enough to fill
the page. Use `containsPattern(query)` for the `ilike` pattern: it escapes `%`
and `_`, so a person typing `50%` finds `50%`.

For data you hold in memory (a fixed list, a cached response), filter with
`matchesQuery(value, query)` inside `fetch`, as the template's
[`search/greetings.ts`](../../apps/_template/search/greetings.ts) does.

## The context

```ts
interface SearchContext {
  user: AppContextUser;                      // always present
  connectors: Record<string, BaseConnector>; // narrowed to declared reads
  db: ReadOnlyScopedClient | null;           // reads only
  services: ServicesClient | null;           // when your app declares `consumes`
  manifest: AppManifest;
  caller: { kind: "search" };
}
```

It is the [MCP tool context](./mcp.md#the-context) for the same reason: a
search answers a question and changes nothing. `db` has no `insert`, `update`,
`upsert` or `delete` (absent from the type, and refused at runtime), connectors
can call only the methods they declare as reads, and there is no
`notifications`, `hooks` or `telemetry`.

**Re-authorize in your own terms.** The platform has checked the person holds
your app; it knows nothing about your roles or per-record rules. Return only
the rows this person could open in your app, exactly as your routes do:
filter by owner, check `ctx.user.hasRole([...])`, and leave out what they
can't see.

## Bounds

| Bound | Value | What happens |
|---|---|---|
| Time | 5 seconds per object | The object shows "Couldn't search this right now."; every other object's rows still show. |
| Results | `limit` per call | Anything past `limit` is dropped. |
| Errors | Thrown or rejected | Logged on the server with the reason; the person sees the same short line, never the error. |
| App updating | Its migrations behind this build | The object shows "This app is being updated." and the handler is not loaded. |

A search runs on every pause in typing, for every app a person holds, so make
the handler cheap: query your own tables, or a snapshot a job keeps fresh
([Data Freshness](./data-freshness.md)). A handler that calls a connector on
every keystroke will hit its budget and the provider's rate limit.

## Verify

1. `npx tsx scripts/generate-project-registry.ts`: a missing handler, a missing
   default export, a `link` to a page that doesn't exist, a 6th object or a 7th
   field fails the build.
2. `npm run typecheck` and `npm run lint`.
3. Install the app, press ⌘K and search for something it holds. Check the top
   five are the ones you expect, **Show 10 more** pages through the rest, and
   Enter opens the right record.
4. Sign in as someone with a narrower role and search again: they should see
   only what they could open.
