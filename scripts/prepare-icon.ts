/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn any logo — a URL or a local file — into a connector icon that passes the
 * registry's checks.
 *
 *   npx tsx scripts/prepare-icon.ts gmail https://example.com/gmail-logo.png
 *   npx tsx scripts/prepare-icon.ts gmail ~/Downloads/logo.jpg
 *
 * WHY THIS EXISTS. The registry demands a square PNG of at least 512x512, and
 * what you find on the internet is a 2364x2364 JPEG with a flat off-white
 * background baked in. Dropped in as-is that ships a grey plate behind the mark
 * — invisible on a light theme and glaring on a dark one, because the icon
 * carries its own background into a surface that already has one.
 *
 * So this does the three things that were otherwise done by hand every time:
 * key out a FLAT background if there is one, trim the transparent margin, and
 * re-pad to a consistent optical size. Providers frame their logos with wildly
 * different whitespace; without the trim-and-repad, one connector's mark is
 * twice the size of its neighbour's in the same grid.
 *
 * Anything with a photographic or gradient background is left alone — keying
 * that would punch holes in the artwork. It is reported, so the author knows to
 * find a better source rather than discovering a ragged icon later.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SIZE = 512;
/** Long edge of the mark inside the square — ~7% breathing room. */
const INNER = 440;
/** A background is "flat" only if the four corners agree this closely. */
const CORNER_TOLERANCE = 6;

async function load(source: string): Promise<Buffer> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { accept: "image/*" } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const file = source.replace(/^~/, process.env.HOME ?? "~");
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  return fs.readFileSync(file);
}

/** The corner colour, when all four corners agree it is one flat colour. */
async function flatBackground(input: Buffer): Promise<[number, number, number] | null> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): [number, number, number, number] => {
    const o = (y * info.width + x) * info.channels;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
  };
  const corners = [
    at(2, 2),
    at(info.width - 3, 2),
    at(2, info.height - 3),
    at(info.width - 3, info.height - 3),
  ];
  // Already transparent: nothing to key, and keying would be destructive.
  if (corners.every((c) => c[3] < 16)) return null;
  const [r, g, b] = corners[0];
  const flat = corners.every(
    (c) =>
      Math.abs(c[0] - r) <= CORNER_TOLERANCE &&
      Math.abs(c[1] - g) <= CORNER_TOLERANCE &&
      Math.abs(c[2] - b) <= CORNER_TOLERANCE,
  );
  return flat ? [r, g, b] : null;
}

/**
 * Remove a flat background with a soft edge.
 *
 * Alpha ramps between two distances from the key colour rather than switching
 * at one, and the recovered pixel is un-blended — the observed colour is the
 * mark composited over the old ground, so keeping it would leave every
 * antialiased edge tinted with whatever the logo used to sit on.
 */
async function keyOut(input: Buffer, bg: [number, number, number]): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  const T0 = 10;
  const T1 = 44;

  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
    const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    const a = Math.max(0, Math.min(1, (d - T0) / (T1 - T0)));
    const q = i * 4;
    if (a <= 0) continue; // already zeroed
    const un = (c: number, ground: number) =>
      Math.max(0, Math.min(255, Math.round((c - (1 - a) * ground) / a)));
    out[q] = un(r, bg[0]);
    out[q + 1] = un(g, bg[1]);
    out[q + 2] = un(b, bg[2]);
    out[q + 3] = Math.round(a * 255);
  }
  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function main() {
  const [name, source] = process.argv.slice(2);
  if (!name || !source) {
    console.error(
      "Usage: npx tsx scripts/prepare-icon.ts <connector-name> <url-or-file>",
    );
    process.exit(1);
  }

  const dir = path.resolve(__dirname, "..", "connectors", name);
  if (!fs.existsSync(dir)) {
    console.error(`No such connector: connectors/${name}/`);
    process.exit(1);
  }

  const raw = await load(source);
  const meta = await sharp(raw).metadata();
  console.log(`Source: ${meta.width}x${meta.height} ${meta.format}`);

  const bg = await flatBackground(raw);
  let working = raw;
  if (bg) {
    console.log(`Flat background rgb(${bg.join(",")}) — keying it out.`);
    working = await keyOut(raw, bg);
  } else {
    console.log(
      "No flat background detected — leaving it as-is.\n" +
        "  If this logo has a photographic or gradient backdrop, find a " +
        "transparent PNG or SVG instead: it will show as a plate behind the mark.",
    );
  }

  const trimmed = await sharp(working).png().trim({ threshold: 1 }).toBuffer();
  const t = await sharp(trimmed).metadata();
  const scale = INNER / Math.max(t.width ?? INNER, t.height ?? INNER);
  const w = Math.round((t.width ?? INNER) * scale);
  const h = Math.round((t.height ?? INNER) * scale);

  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const out = path.join(assets, "icon.png");

  await sharp(trimmed)
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .extend({
      top: Math.floor((SIZE - h) / 2),
      bottom: Math.ceil((SIZE - h) / 2),
      left: Math.floor((SIZE - w) / 2),
      right: Math.ceil((SIZE - w) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: true })
    .toFile(out);

  const final = await sharp(out).metadata();
  console.log(
    `\nWrote connectors/${name}/assets/icon.png — ${final.width}x${final.height}, ` +
      `${(fs.statSync(out).size / 1024).toFixed(1)} KB.`,
  );
  console.log(`Declare it:  "icon": "icon.png"`);
  console.log(
    "Then LOOK at it. Keying is a heuristic; a logo that was drawn against a " +
      "coloured plate can lose its own light areas.",
  );
}

void main();
