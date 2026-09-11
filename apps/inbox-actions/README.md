# Inbox Actions

A triage board over a shared mailbox. It shows the latest messages and flags the
ones that appear to be asking for something — and next to each flag, the sentence
that asked.

The point is the evidence. A message reading "2 action items" is only useful if
you can see which two sentences produced that number, so every detection carries
the line it matched and the page renders it. You never have to trust a badge; you
can disagree with it in a glance.

## Who it is for

A team working a shared mailbox — support@, hello@, an ops alias — that wants to
know which of the last few days of mail is actually waiting on someone. It is a
triage aid, not a ticketing system: nothing here assigns, replies, or changes
anything in Gmail.

## What it needs

**The Gmail connector, configured by an admin** at `/admin/connectors`. Until it
is, the app's pages and widgets render an explicit unconfigured state rather than
empty results.

**A scoped database.** The app owns one table of synced messages.

No `env` settings, no `egress` hosts, no declared `escapes`, and no
notifications.

## Worth knowing

**The mailbox is shared, not yours.** The Gmail connector is tenant-scoped: one
mailbox that an admin connected, with one credential set used by every user of
the app. Everyone who can open Inbox Actions sees the same mail. The UI says
"shared mailbox" everywhere for this reason, and the app should not be installed
against a mailbox whose contents are not appropriate for all of its users.

**It syncs on a schedule.** A declared sync named `messages` runs every 15
minutes: a 7-day window on a cold start, 2 days in steady state, with a wall-clock
budget of 200 seconds per tick. Pages and widgets read from the app's own table
and never call Gmail on the request path, so a page load does not wait on the
connector and still renders when it is down.

**Messages are kept for 30 days.** Older rows are pruned once a sync run drains
its window. This is a board for recent mail, not an archive.

**Detection is rules, not a model.** There is no LLM behind it. The detector
looks for three shapes of ask — an assignment ("needs your approval"), a request
("could you…", "please send…"), and a question aimed at the reader — plus date
and urgency cues for a deadline flag. Before any of that it strips quoted history
and signature blocks, which matters more than the rules do: without it, a short
"Thanks, done!" on top of a twelve-message thread inherits every request ever
made in that thread. Newsletter and footer boilerplate ("unsubscribe", "let me
know if you have any questions") is filtered out so the flag keeps meaning
something.

It will miss asks, and it will occasionally flag a sentence that only looks like
one. That is why it shows its work.
