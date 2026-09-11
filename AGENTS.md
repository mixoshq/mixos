<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Apps, connectors and themes

If the user's request involves creating or modifying an **app** (anything under `apps/`), a **connector** (anything under `connectors/`), or a **theme** (anything under `themes/`), you **must** read the corresponding guide in full before writing code:

- Apps → [`apps/AGENTS.md`](apps/AGENTS.md)
- Connectors → [`connectors/AGENTS.md`](connectors/AGENTS.md)
- Themes → [`themes/AGENTS.md`](themes/AGENTS.md)

These guides are the authoritative spec for file layout, manifests, APIs, security boundaries, and the invariants that agents most often get wrong. Do not infer conventions from surrounding code alone.
