<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Apps and connectors

If the user's request involves creating or modifying an **app** (anything under `apps/`) or a **connector** (anything under `connectors/`), you **must** read the corresponding guide in full before writing code:

- Apps → [`apps/AGENTS.md`](apps/AGENTS.md)
- Connectors → [`connectors/AGENTS.md`](connectors/AGENTS.md)

These guides are the authoritative spec for file layout, manifests, APIs, security boundaries, and the invariants that agents most often get wrong. Do not infer conventions from surrounding code alone.
