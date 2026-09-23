# App Shell & Information Architecture

[`ux.md`](ux.md) is the floor — what every surface must do before it ships. This guide is the layer above it: **how a screen is organised.** Where settings live, how pages relate to each other, what survives a Back button, what a read-only user sees.

None of this is enforced by the platform. It's here because these questions have already been answered once, well, in a real app — and the answers are not obvious enough to re-derive correctly under time pressure. Each pattern below is written as the shape to copy, not as a pointer at code you can read.

---

## Choosing a settings surface

The single most consequential layout decision in an app, and the easiest to get backwards.

**Scope picks the surface:**

| Settings scope | Surface | Why |
| --- | --- | --- |
| App-wide — an admin sets it once, applies to every record | **Configure page** with a left sub-nav, reached by a gear icon in the page header | There's no record to keep on screen, and there's usually enough of it to need sections |
| One record — this customer's fields, this project's dates | **Modal on that record's page** | The thing being configured stays visible behind the modal; the user doesn't lose their place |

Getting this backwards produces the two tells: a settings *page* that needs a record ID in its URL, or a settings *modal* an admin has to hunt through the app to find.

### The Configure page

Use [`ConfigureShell`](../../src/components/ui/configure-shell.tsx) — back link, title, left sub-nav, content column:

```tsx
// apps/<slug>/pages/configure/customer_segmentation/Main.tsx
import ConfigureShell from "@/components/ui/configure-shell";
import { CONFIGURE_NAV } from "../nav";

export default function Page() {
  return (
    <ConfigureShell appSlug="my-app" nav={CONFIGURE_NAV} active="customer_segmentation">
      <SegmentationEditor />
    </ConfigureShell>
  );
}
```

Two things about this that regularly surprise people:

- **Each Configure page renders the shell itself.** App pages get no shared layout in this version of Next — there is no `layout.tsx` to hang the sub-nav off. That's the constraint the component exists to paper over, not an oversight to fix.
- **Nav keys are frozen; labels are not.** The `key` doubles as the URL segment, so a panel relabelled "Resource Library" still lives at `customer_resources` — which is also the name of the table and the route behind it. Renaming a key breaks every bookmark and shared link. Rename the label freely.

Order the nav **the way an admin sets the app up**, not alphabetically. The first-run path through the settings is the most valuable thing the ordering can encode.

### The record modal

For per-record settings, open a modal from the record's own page. Group its content into the same `SectionCard` stack a Configure page would use — the difference is where it lives, not how it's built.

## Page header & action hierarchy

Use [`AppPageHeader`](../../src/components/ui/app-page-header.tsx): title, optional one-line subtitle, right-aligned actions.

**What earns a spot in the header:** actions a user reaches for repeatedly — Refresh, a sibling view, Configure. At most one is `variant: "primary"`; if two things are primary, neither is.

**What goes in an overflow menu instead:** destructive operations, mode toggles, external links, anything used once a month. A header with nine buttons has no primary action, only nine equal ones.

```tsx
<AppPageHeader
  title="Projects"
  subtitle={counts.visitsRemaining > 0 && (
    <><span className="font-semibold text-foreground">{counts.visitsRemaining}</span> site visits remaining</>
  )}
  actions={[
    { label: "Refresh", icon: RefreshCw, onClick: refresh, busy: fetching, disabled: fetching },
    { label: "Site Visits", icon: MapPin, href: "/apps/my-app/visits" },
    { label: "Configure", icon: Settings, href: "/apps/my-app/configure" },
  ]}
/>
```

The subtitle is a good place for a live count or a filter summary — it makes the header carry state instead of just naming the page.

## Tabs

[`FolderTabs`](../../src/components/ui/folder-tabs.tsx) switches between **peer views of one record** — not between unrelated destinations, which is what navigation is for.

**Filter, don't disable.** A tab for a feature this record doesn't use should not render at all:

```tsx
<FolderTabs
  items={MAIN_TABS.filter((t) => t.key !== "data-services" || dataServiceEnabled)}
  active={activeTab}
  onChange={setActiveTab}
  surface="card"
/>
```

A disabled tab poses a question — *why can't I click that?* — which a tab bar has no room to answer. Absence asks nothing.

Pass `surface` to name what sits beneath the band. The active tab merges into the panel below by matching its fill; a tab band above a `bg-card` panel and one above a `bg-muted` page need *different* fills to produce the *same* illusion. Copying a literal colour between the two is what breaks the effect.

**Tab by subject, not by lens.** Tabs are *where a thing lives*; they are not a second axis of analysis. If two tabs would hold the same records viewed differently, that's a filter or a toggle inside one tab. The test: can you name each tab as a noun the user came looking for? "Backlog", "Resolution", "Dev Handoffs" pass. "Risk" and "Record" don't — those are readings of the same records, and splitting them means the user has to visit two tabs to understand one thing.

**One navigation system per page.** A page with tabs *and* a jump-link sub-nav *and* collapsible sections has three ways to reach the same content and no single answer to "where am I?". Pick tabs, and let the sections inside a tab simply be open.

### Badge counts

`FolderTabs` takes an optional `badge` per item — a count in a `bg-destructive` circle on the tab's outer corner. It draws the eye harder than anything else in the header, so it has one job: **count records someone can act on.**

- **Things, not states.** `3` unanswered handoffs is a badge. "2 categories below target" is a *measurement* — badging it invites reading a reading as a to-do, and the number never goes down by doing anything, so it stops meaning anything.
- **A badge you can't clear is noise.** If a count includes work that is structurally always open — a track with no SLA, a queue owned by another team — exclude it and say so in a comment where the count is built. Otherwise the badge is a permanent alarm, and users learn to stop seeing it.
- **Exclude by construction, not by filter.** If a category (data hygiene, say) must never reach a badge, make the builder incapable of emitting it rather than filtering it at the call site. Filters get copied and forgotten.
- **Always pass `badgeLabel`.** The circle is a bare number to a screen reader otherwise. `badgeLabel="3 handoffs need your input"` is what makes it information.
- **Zero renders nothing.** Don't badge a `0`; absence is the message.

## Cards: one shell per thing, and every card says who owns it

Use [`Card`](../../src/components/ui/card.tsx) for the shell and `CardHeader` for the header row. They exist because 86 hand-rolled `rounded-lg border border-border bg-card` shells across 16 apps had drifted into different paddings, different header sizes, and h1–h4 for the same visual weight.

**Two card families, and picking the wrong one is the usual mistake.** [`SectionCard`](../../src/components/ui/section-card.tsx) is a *form section* — small `h3` label, a `hint` line, a rule under the header, and a `SaveRow` footer whose absence is the read-only permission model. Use it on Configure pages and settings screens. `Card` is a *dashboard panel* — `text-lg` title, an optional `description` line, right-hand status slot, no footer. They share `CARD_SHELL` **and the padding scale**, so they can't drift on radius, border, fill or inset.

**The padding scale is one number: `5`.** Header, body and footer each inset by `5` on every side they own, so a headerless card is exactly `p-5`. Don't reach for `p-4`, `px-6 py-8` or `py-16` on a card — those were the old drift, and the analytics panels had been hand-rolled at `p-5` precisely because the primitive didn't offer it.

**Inline cards are flat.** No `shadow-*`. The border is the edge. Elevation means "this floats above the page" and belongs only to `Dialog` (`shadow-xl`) and `Menu` (`shadow-lg`) — a shadow on an inline panel is a promise of depth the card doesn't keep.

**`CARD_SHELL` vs `CARD_SURFACE`.** `CARD_SURFACE` is the chrome alone — radius, border, fill. `CARD_SHELL` is that plus the `.mix-card` theme hook, and is what an ordinary card wants. A surface owning a *different* hook — a widget (`.mix-widget`), a modal (`.mix-modal`), a dropdown (`.mix-popover`) — takes `CARD_SURFACE` and adds its own. Those are separate entries in `SURFACE_ALLOWLIST` so a theme can restyle dashboard widgets without also restyling every settings panel; handing them `CARD_SHELL` collapses four themeable surfaces into one.

**Two tiers, and only the outer one is a card.** A repeated row or field group *inside* a card — the entry blocks in `apps/career`'s library, a `<fieldset>` of related inputs — is `rounded-md border border-border p-4` with **no fill of its own**. It sits on the card's ground. Giving it `bg-card` and `p-5` makes a card inside a card, which is the double-card bug below wearing a disguise.

```tsx
<Card>
  <CardHeader
    as="h2"
    title="Backlog composition"
    description="Open items by track, over the selected range."
    right={<span>updated 4m ago</span>}
  />
  <CardBody>…</CardBody>
</Card>
```

- **`as` is not cosmetic.** The heading level is the document outline a screen-reader user navigates by. A card inside a section that already has an `<h2>` takes `as="h3"`. The visual size comes from the component; the level comes from where you are.
- **`divided` draws the rule under the header.** Opt in per app and then be consistent — a page where some cards rule their header and some don't reads as unfinished.
- **`description` is prose, and sits under the title, not in the row.** A sentence sharing a flex row with chips and a status slot wraps into a mess at narrow widths.
- **`right` is for status, not actions.** A refresh button, a filter, a "notify" trigger belong in the body next to what they affect. The header's right slot is where "updated 4m ago" goes.

### A component owns its card, or it doesn't, and its name says which

The single most common card bug is the **double card**: a panel that draws its own shell, rendered inside a parent that also draws one. You get a border 8px inside a border, doubled padding, and two header rules. Four of these shipped in one app; two were only visible in a single data state, which is exactly why they survived review.

The fix is a naming convention, not vigilance:

> A component whose name ends in `Card` or `Panel` **draws its own shell**. Anything else returns bare content and must be placed inside one.

So `<BacklogCard />` is never wrapped, and `<BacklogChart />` always is. When you find yourself passing a `bare` or `noCard` prop, that's the convention asking to be applied instead: split it, or rename it.

Two variants of the same content genuinely do need to look different — one as a standalone card, one nested inside another. Handle that by having the *card* component render the *content* component, never by branching the shell on a prop.

## State that survives navigation

### Filters belong in the URL

If a user filters a list, opens a record, and hits Back, they must land on the list they left. That means filter state lives in the URL, read once on mount:

```tsx
const initial = useMemo(() => {
  const params = typeof window === "undefined"
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
  return {
    // An ABSENT param and an explicit "all" are different things:
    // absent = a fresh visit, so default to the signed-in user;
    // "all" = the user deliberately widened the scope, carried back from detail.
    hadOwnerParam: params.has("ownerId"),
    ownerId: params.get("ownerId")?.trim() || "all",
    // A present-but-empty `stages` round-trips "nothing selected" faithfully.
    stages: params.has("stages")
      ? (params.get("stages") ?? "").split(",").map(s => s.trim()).filter(Boolean)
      : null,
  };
}, []);
```

The absent-vs-explicit distinction is the part that's easy to miss. Collapse them and you get the bug where returning from a detail page silently re-scopes the list to "mine".

#### `window.location.search` is only safe when the value changes *data*, not markup

The `useMemo` above renders an empty `URLSearchParams` on the server and the real ones on the client. That is fine for the pattern it's shown in — the values feed a *fetch*, the first paint is a skeleton either way, and the server and client agree on the markup.

**It is not fine for a value that decides what renders.** Seed a tab from `window.location.search` and the server renders tab one while the client renders tab three; React finds a mismatched tree, throws away the server HTML, and re-renders the whole subtree client-side. The visible symptom is a hydration error and a flash of the wrong tab. Use [`useSearchParams`](https://nextjs.org/docs/app/api-reference/functions/use-search-params):

```tsx
const searchParams = useSearchParams();
const [tab, setTab] = useState<TabKey>(() => {
  const t = searchParams.get("tab");
  return TABS.some((x) => x.key === t) ? (t as TabKey) : "overview";
});
```

`useSearchParams` returns the real params during SSR of a **dynamic** route, so both sides render the same tab. App pages are dynamic by construction: the gateway calls `requireReadOnlySession()`, which reads cookies. If you ever render an app page statically, `useSearchParams` needs a `<Suspense>` boundary — but that isn't reachable today.

**And once the tab lives in state, every path into it has to go through the setter.** A `<Link href="?tab=dev-handoffs">` looks correct and does nothing: client-side navigation to the same route rewrites the query string without remounting, so the initializer never re-runs. The address bar moves and the page doesn't — a bug that reads as "the link is broken" and greps as "the link is fine". Make in-page tab jumps buttons that call `setTab`, and let one effect write the URL:

```tsx
<button type="button" onClick={() => setTab("dev-handoffs")}>
  → Dev Handoffs board
</button>
```

Reserve `<Link href="?…">` for crossing into a *different* route, where the remount does happen.

### Long-lived preferences belong in localStorage — carefully

A preference that should outlive the tab (a display mode, a screen-share toggle) goes in `localStorage`. **Do not read it in a `useState` initializer** — the server renders `false`, the client reads `true`, and you get a hydration mismatch. Use `useSyncExternalStore` with a `false` server snapshot:

```tsx
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  window.addEventListener("storage", onStorage); // keeps tabs in sync
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

const value = useSyncExternalStore(subscribe, readStore, () => false);
```

SSR and the first client render agree, the value updates after hydration, and the `storage` listener keeps two open tabs consistent.

## Permission-aware UI

Per-app roles are declared in `app.json` and enforced *by your route handlers* — the platform stores the role but decides nothing (see [`roles.md`](roles.md)). The UI layer on top has two rules.

### Fail closed

Expose the current user's capability through a context that **defaults to `false`** and only becomes `true` once the server confirms it:

```tsx
const CanEditContext = createContext<boolean>(false); // fail-closed

export function CanEditProvider({ children }: { children: ReactNode }) {
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    let active = true;
    createAppClient(SLUG).get<{ canEdit?: boolean }>("/me")
      .then((r) => { if (active) setCanEdit(!!r?.canEdit); })
      .catch(() => { if (active) setCanEdit(false); });
    return () => { active = false; };
  }, []);
  return <CanEditContext.Provider value={canEdit}>{children}</CanEditContext.Provider>;
}
```

Controls stay hidden until the role is confirmed, so a slow `/me` never briefly offers an action the user doesn't have. **This is UX only** — a spoofed `true` here still can't write, because the route checks `hasRole` independently. That separation is what makes it safe to be relaxed about the client-side value.

### Omit, don't disable

A read-only user should see the same content with **no save affordance**, not a greyed-out one:

```tsx
<SectionCard
  title="Check-in cadence"
  footer={canEdit ? <SaveRow onSave={save} saving={saving} dirty={dirty} saved={saved} /> : undefined}
>
```

A disabled button advertises a capability the user doesn't have and sends them hunting for why it's off. An absent one just reads as reference material. This is why `SectionCard`'s `footer` is optional rather than a `disabled` prop.

## Presentation modes

Two different things get conflated, and they need different mechanisms:

| | Screen-share mode | Public / shared page |
| --- | --- | --- |
| Who's looking | Your user, with a customer watching | The customer, on their own |
| Auth | Normal session | `pageVisibility: public` or `password` |
| Editing | **Still on** — the user is working | Off |
| What's hidden | Internal-only content: ARR, CRM links, internal owner names | Everything not explicitly published |

Screen-share mode is a client-side filter over the *same* page (`{!customerMode && <MondayLink />}`), persisted per user. A public page is a genuinely separate surface with its own route, its own auth, and `context.user === null`. Don't try to make one do the other's job: a client-side flag is not a security boundary, and a public page can't be edited.

## Designed states, by cause

Covered in [`ux.md`](ux.md#empty-error--not-connected-states) — the short version is that "empty" is three different screens, and `EmptyState` requires you to say which one.

One addition at this layer: **degrade, don't fail.** When an app pulls from several sources and one is down, render what you have and say what's missing inline:

```tsx
{data?.gongDegraded && (
  <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
    Gong call data is temporarily unavailable — last-activity timing is using monday.com activity only.
  </div>
)}
```

The user gets a working page and an accurate account of what they're looking at. Failing the whole page over a partial outage throws away the data you *did* fetch.

## Guided onboarding

If an app needs a walkthrough, spotlight the **real controls**, never a mock-up of them. A tour that teaches a fake UI teaches nothing transferable, and it silently rots the moment the real UI moves.

The shape that works: measure a live `getBoundingClientRect` on a CSS selector and portal a ring + bubble to `position: fixed`. Three things a working implementation learned the hard way, which any similar flow will hit:

- **The page scrolls inside the app shell's `<main class="overflow-auto">`, not the window.** A plain `window.scroll` listener never fires and `window.scrollY` is always `0` — register in the **capture** phase to see the inner scroller.
- **Targets sit inside `overflow-hidden` columns**, so the ring must be portalled out and positioned `fixed`. Using the spotlight's clear rectangle to mark the target also means no card has to accept a `highlight` prop to participate.
- **Poll for the target.** Revealed cards fade in and panels animate their height, so the element may not exist — or may still be moving — on the first frame.

And two rules about how a guide should behave:

- **A target that never appears is not an error.** Hide the callout and let the instruction bar carry the step. A walkthrough that hard-fails on a missing selector is worse than no walkthrough.
- **Never disable the confirm button on unsatisfied data.** Show a hint next to it instead. The user may know something the check doesn't, and a dead-end step in a guided flow has no escape.

---

## Where each pattern lives in an app

| Pattern | Conventional home |
| --- | --- |
| Configure page + sub-nav | `pages/configure/<panel>/Main.tsx`, with the nav in `pages/configure/nav.ts` |
| Header actions, URL filter state, states by cause | the page's own `Main.tsx` |
| Tabs, screen-share mode, overflow menu | a detail page's `Main.tsx` |
| Fail-closed permissions | `lib/use-can-edit.tsx` (client context) + a `/me` route |
| localStorage without hydration mismatch | `lib/<preference>-mode.tsx`, via `useSyncExternalStore` |
| Guided onboarding | `components/setup-guide/` |
