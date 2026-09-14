# Your Connector Name

<!-- Links and images must be absolute https:// URLs — a relative ./setup.md or
     ./screenshot.png resolves against mixos.org, not your repo, and publishes as
     a dead link. Raw HTML is stripped, this comment included. Delete it. -->

One or two sentences on what this connector gives a MixOS workspace. Assume the
reader has just found it in a catalogue and is deciding whether to set it up.

Note this is *not* `description` in the manifest. That field answers "what is
this service?" in 140 characters. This file answers "what will connecting it let
me do, and what will it cost me?"

## What it can reach

The data and operations it exposes, in the reader's terms — "messages, threads
and labels", not "six methods". Say plainly whether it is read-only.

## What you need before you start

What the admin must have on the provider side: an account tier, an API key, an
OAuth app they create themselves, a particular role. The numbered provisioning
steps live in `setup` in the manifest and the registry renders them — do not
repeat them here.

## Access it asks for

Which scopes are requested by default and what each one lets the connector do.
If the provider's scopes are coarser than you would like, say so; a reader
deciding whether to connect their company's mail deserves to know.

## Worth knowing

Rate limits that bite in practice, whether it is tenant-scoped or per-user,
what happens when a credential expires, and anything it deliberately does not do.
