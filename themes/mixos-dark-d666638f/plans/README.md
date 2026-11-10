# Plans for this theme

Build plans scoped to this theme live here, one file per piece of work:

```
YYYYMMDD_HHMM-<plan-name>.md
```

Write one **before** editing code for anything beyond a token re-tone — a theme
repaints every app in the install at once. Cover **Context** (why), **Decisions**
(anything locked with the user), **Structure**
(`theme.json`, `theme.css`, `assets/`), and **Verification** (how you'll prove it works).

Keeping plans beside the `theme.json` means the design history travels with the
theme — a clone, a conversion, or a handoff carries both.

A change that touches the platform itself (`src/`, `scripts/`, the build) is a
**platform plan** and belongs in [`docs/plans/`](../../../docs/plans) instead.

Full convention: [`docs/plans/README.md`](../../../docs/plans/README.md). Command: [`/mixos theme`](../../../.claude/skills/mixos/actions/theme.md).

---

**Origin.** `mixos-dark` was split out of `mixos` by the platform plan that
collapsed the light/dark mode axis into the theme axis:
[`docs/plans/20260826_2041-single-palette-themes.md`](../../../docs/plans/20260826_2041-single-palette-themes.md).
Its palette came from the dark-legibility work in
[`docs/plans/20260826_1959-dark-mode-legibility.md`](../../../docs/plans/20260826_1959-dark-mode-legibility.md).

It is **not** a maintained mirror of [`mixos`](../../mixos/). The two share a
starting point and are free to diverge; a re-tone here implies nothing about
the other, and there is no build check tying them together.
