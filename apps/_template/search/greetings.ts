import { matchesQuery, searchFields, type SearchInput } from "@/lib/apps/search";
import type { SearchContext } from "@/lib/hooks/types";
import { GREETINGS, type Greeting } from "../lib/shared/greetings";

/**
 * Example search handler: makes this app's greetings findable from MixOS's
 * global search (⌘K).
 *
 * Declared in app.json under `search`, with the fields it searches and the
 * page a result opens (`"link": "greetings?id={id}"`). MixOS calls it with
 * what the person typed, the declared field keys (title first), and which page
 * of results it wants. Return up to `input.limit` results; the platform fills
 * in each one's link from the template and URL-encodes the values.
 *
 * `searchFields` is the ranking every app shares: a match in the first field
 * ranks above a match in the next, each result listed once. `fetch` returns up
 * to `take` rows where one field contains the query. Over a table, that is
 *
 *   ctx.db!.table("greetings")
 *     .select("id, phrase, language")
 *     .ilike(field, containsPattern(input.query))
 *     .order("created_at", { ascending: false })
 *     .limit(take)
 *
 * Handlers are READ-ONLY, as MCP tools are: `ctx.db` has no
 * insert/update/upsert/delete. Return only what this person could open in the
 * app — check `ctx.user.hasRole(...)` as your routes do.
 *
 * See docs/apps/search.md.
 */
export default async function searchGreetings(_ctx: SearchContext, input: SearchInput) {
  return searchFields<Greeting>({
    input,
    fetch: (field, take) =>
      GREETINGS.filter((g) => matchesQuery(g[field as keyof Greeting], input.query)).slice(0, take),
    toResult: (g) => ({ id: g.id, title: g.phrase, subtitle: g.language }),
  });
}
