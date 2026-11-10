# MixOS

The default MixOS theme, and the fallback every workspace lands on before
anyone chooses otherwise.

## What it looks like

Slate and cyan on a light ground, taken from the MixOS brand guidelines v1.0.
Restrained rather than characterful on purpose — it is the backdrop for whatever
apps a workspace installs, and a default theme that asserts itself makes every
app look like it is fighting the furniture.

## Where it came from

The MixOS brand book, applied directly. Every one of its 24 contrast pairs is
verified at build time, so text on any surface it defines meets the contrast
floor rather than meeting it by inspection.

## What it ships

Three font families: Plus Jakarta Sans for display, Inter for body, JetBrains
Mono for code. A logo, favicon and both app icon sizes. It styles the base
tokens only and overrides no `.mix-*` surfaces, which is what makes it a safe
thing to sit underneath anything.

## Worth knowing

[MixOS Dark](https://github.com/mixoshq/mixos/tree/main/themes/mixos-dark-d666638f) is
its counterpart — the same palette with the roles inverted, not a filter applied
to this one. A workspace picks one; there is no automatic switching, which is a
deliberate platform decision rather than an omission here.
