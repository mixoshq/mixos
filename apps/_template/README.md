# Your App Name

<!-- Links and images must be absolute https:// URLs — a relative ./setup.md or
     ./screenshot.png resolves against mixos.org, not your repo, and publishes as
     a dead link. Raw HTML is stripped, this comment included. Delete it. -->

One or two sentences on what the app does. Assume the reader has just found it in
a catalogue and is deciding whether it is worth installing.

## Who it is for

The person or team this is aimed at, and — just as usefully — who it is not for.

## What it does

The two or three things somebody would actually use it for. Name the pages and
widgets it ships, since those are what the reader gets.

## What it needs

Everything an admin has to do before it works: connectors they configure at
`/admin/connectors`, `env` settings from the manifest and what goes in them,
whether it wants a scoped database. Say "nothing" if the answer is nothing — that
is a selling point.

## Worth knowing

Anything surprising about how it behaves. Scheduled jobs and how often they run,
how long data is kept, hosts it reaches through `egress`, declared `escapes`,
whether it is a `global` app, and anything it deliberately does not do.

Leave installation out. The catalogue owns that.
