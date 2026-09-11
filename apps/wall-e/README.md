# Wall·E

A dashboard widget that shows one line from WALL·E, chosen by the date and the
same for everyone until tomorrow.

There is nothing to configure. Add the widget to a dashboard and it works: no
title field, no character filter, no rotation setting. Thirty-one lines rotate
by day — Captain McCrea, AUTO, EVE, M-O, the Axiom announcer, Buy N Large, and a
few from *Hello, Dolly!*

## Who it is for

Anyone who wants a small, warm thing on a dashboard otherwise full of numbers.
It is a morale widget and makes no claim to be more than that.

## What it needs

Nothing. No connectors, no database, no scheduled jobs, no network access. The
quote list is an array in the app's own source, because thirty-one rows nobody
edits at runtime is not a database.

## Worth knowing

**It is a global app.** The manifest sets `"global": true`, which means every
user of the instance is implicitly granted it and the grant cannot be revoked
per-user. Users still choose whether to place the widget on their dashboard, but
an admin cannot hand it to some people and not others. If that is not what you
want, this is the wrong app to install.

**The day is decided by the server, in UTC.** The widget asks an API route
rather than reading the clock in the browser. That is what makes "everyone sees
the same line today" true rather than approximately true — two browsers in
different timezones would otherwise disagree across midnight, and the widget
renders on the server before it hydrates, so a date read in both places is a
hydration mismatch waiting to happen.

**The quotes are faithful-as-remembered, not transcribed.** Corrections are a
one-line change to `lib/shared/quotes.ts`.
