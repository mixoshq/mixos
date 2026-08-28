/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour parsing and WCAG contrast maths for the theme validator.
 *
 * Deliberately supports only formats that can be resolved to a concrete sRGB
 * triple at build time: hex, `rgb()`, `hsl()`, and a `var()` reference to
 * another token in the same block. A token whose value the build cannot
 * evaluate — `color-mix()`, `oklch()`, a runtime `var()` chain that escapes the
 * block — is REJECTED rather than skipped. Skipping would mean the contrast
 * gate quietly stops covering that token, which is worse than not having the
 * gate: the build would still report success.
 */

export type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function hexToRgb(hex: string): Rgb {
  const h =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

/**
 * Resolve `var(--x)` chains within one declaration block. This is what lets a
 * theme write `--primary: var(--brand-cyan)` and keep the literal brand value
 * and its semantic role from ever drifting apart, rather than repeating the
 * same hex in two places and hoping they stay in step.
 */
export function resolveVar(
  value: string,
  block: Map<string, string>,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  const ref = value.trim().match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!ref) return value.trim();
  const next = block.get(ref[1]);
  return next == null ? null : resolveVar(next, block, depth + 1);
}

/** Parse a resolved colour value to sRGB. Returns null if not evaluable. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();

  if (v === "white") return [255, 255, 255];
  if (v === "black") return [0, 0, 0];

  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return hexToRgb(v);

  const rgb = v.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*[\d.%]+\s*)?\)$/,
  );
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) =>
      Math.max(0, Math.min(255, Math.round(n))),
    ) as Rgb;
  }

  const hsl = v.match(
    /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,]\s*[\d.%]+\s*)?\)$/,
  );
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));

  return null;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded the way the docs and error messages quote it. */
export function ratioText(n: number): string {
  return `${n.toFixed(2)}:1`;
}
