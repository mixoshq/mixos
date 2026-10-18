# MixOS Dark

The dark counterpart to the default MixOS theme.

## What it looks like

Slate and cyan on a dark ground. The same brand palette as
[MixOS](https://github.com/mixoshq/mixos/tree/main/themes/mixos), with the
roles deliberately reassigned rather than inverted — a dark theme built by
flipping a light one produces washed accents and text that is technically
readable and tiring in practice.

## Where it came from

The MixOS brand guidelines v1.0, same source as the light theme. Its 24 contrast
pairs are verified at build time against the dark ground, independently of the
light theme's.

## What it ships

The same three font families as the light theme — Plus Jakarta Sans, Inter,
JetBrains Mono — with its own logo, favicon and app icons sized for a dark
background. Base tokens only; no `.mix-*` surface overrides.

## Worth knowing

This is a separate theme, not a mode. A workspace selects it explicitly and it
does not follow the operating system's dark preference — MixOS treats a theme as
a choice someone made, not a condition to be detected.
