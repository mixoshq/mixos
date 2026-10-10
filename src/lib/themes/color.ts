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
 *
 * Alpha is parsed rather than dropped, so the validator can reject a
 * translucent token, or composite the one it allows (`--border`) over
 * `--background`. A translucent colour on screen depends on whatever is
 * painted behind it, so it has no single sRGB triple to measure, and measuring
 * it as though it were opaque overstates its contrast.
 */

export type Rgb = [number, number, number];

/** A parsed colour. `alpha` is 1 for an opaque one. */
export interface Color {
  rgb: Rgb;
  alpha: number;
}

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

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, already lowercased. */
function parseHex(hex: string): Color {
  const short = hex.length <= 5;
  const digits = short
    ? [...hex.slice(1)].map((d) => d + d)
    : hex.slice(1).match(/../g)!;
  const [r, g, b, a] = digits.map((d) => parseInt(d, 16));
  return { rgb: [r, g, b], alpha: a === undefined ? 1 : a / 255 };
}

/** An alpha component, `0.5` or `50%`. Absent means opaque. */
function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Math.max(0, Math.min(1, n));
}

/**
 * Where a `var()` chain ends: a literal, a token the block never sets
 * (`missing`, reached through `chain`), or a chain that comes back to itself.
 */
export type Resolution =
  | { value: string }
  | { missing: string; chain: string[] }
  | { loop: string[] };

/**
 * Follow a `var(--x)` chain within one declaration block. This is what lets a
 * theme write `--primary: var(--brand-cyan)` and keep the literal brand value
 * and its semantic role from ever drifting apart, rather than repeating the
 * same hex in two places and hoping they stay in step.
 *
 * A chain that ends in nothing leaves the property unset in the browser, so the
 * caller must fail on it rather than leave the token out: a token missing from
 * the resolved block is one every check downstream silently skips. `chain` is
 * the tokens already followed; start it with the token being resolved, so a
 * self-reference is reported as a loop.
 */
export function resolveVar(
  value: string,
  block: Map<string, string>,
  chain: string[] = [],
): Resolution {
  const ref = value.trim().match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!ref) return { value: value.trim() };
  const name = ref[1];
  if (chain.includes(name)) return { loop: [...chain, name] };
  const next = block.get(name);
  if (next == null) return { missing: name, chain };
  return resolveVar(next, block, [...chain, name]);
}

/**
 * Parse a resolved colour value. Returns null if not evaluable. Alpha is
 * returned, never dropped: whether a translucent colour is acceptable is the
 * caller's decision, and it cannot make it if the alpha was thrown away here.
 */
export function parseColor(value: string): Color | null {
  const v = value.trim().toLowerCase();

  if (v === "white") return { rgb: [255, 255, 255], alpha: 1 };
  if (v === "black") return { rgb: [0, 0, 0], alpha: 1 };

  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return parseHex(v);

  const rgb = v.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/,
  );
  if (rgb) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) =>
        Math.max(0, Math.min(255, Math.round(n))),
      ) as Rgb,
      alpha: parseAlpha(rgb[4]),
    };
  }

  const hsl = v.match(
    /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/,
  );
  if (hsl) {
    return {
      rgb: hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3])),
      alpha: parseAlpha(hsl[4]),
    };
  }

  return null;
}

/** Alpha-composite `fg` at `alpha` over the opaque `bg`. */
export function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;
}

/** `#rrggbb`, the one spelling the generated token table carries. */
export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
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
