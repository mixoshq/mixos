# Wall·E

A dashboard widget that shows one line from WALL·E, chosen at random and the
same for everyone until the top of the next hour.

There is nothing to configure. Add the widget to a dashboard and it works: no
title field, no character filter, no rotation setting. Thirty-one lines — Captain
McCrea, AUTO, EVE, M-O, the Axiom announcer, Buy N Large, and a few from *Hello,
Dolly!* — take turns in an order you cannot predict from the current one.

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

**The hour is decided by the server.** The widget asks an API route rather than
reading the clock in the browser, and the route says when the line changes next.
That is what makes "everyone sees the same line right now" true rather than
approximately true — two browsers with clocks a few minutes apart would
otherwise disagree across the boundary, and the widget renders on the server
before it hydrates, so a clock read in both places is a hydration mismatch
waiting to happen.

**Random, but not re-rolled per request.** The order is derived from the hour,
so it is unpredictable while everyone asking within the same hour gets the same
answer — a fresh `Math.random()` per request would change the quote as you
navigate and give no answer to "when does it change?".

**Every line, once per run.** Each run of 31 hours is a fresh shuffle of all 31
lines rather than an independent draw per hour. Drawing per hour would repeat
the previous line roughly once a day and, over a year, show some lines a third
more often than others; shuffling gives 0 repeats and 282–284 airings each.

**The quotes are faithful-as-remembered, not transcribed.** Corrections are a
one-line change to `lib/shared/quotes.ts`.
