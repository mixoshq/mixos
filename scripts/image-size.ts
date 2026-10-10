/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Image measurement for the registry generator: screenshots, connector icons,
 * and brand logos.
 *
 * Its own module so it can be tested. The generator runs on import, so nothing
 * inside it can be imported by a test.
 */

/**
 * Read an image's pixel dimensions from its header.
 *
 * Deliberately not an image library. The only fact needed here is width and
 * height, both of which sit in the first few dozen bytes of a PNG or WebP, and
 * `sharp` is present in this tree only as a transitive dependency of Next —
 * importing it in the build would be depending on someone else's dependency.
 *
 * Returns null for a format whose header isn't parsed here, which the caller
 * treats as "cannot measure", not as "passes".
 */
export function readImageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR carrying two big-endian uint32s.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // WebP: RIFF container, and three sub-formats that each store size differently.
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") {
      // Lossy: 14-bit dimensions after the 3-byte start code.
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      // Lossless: 14 bits each, packed across a 32-bit little-endian read.
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8X") {
      // Extended: 24-bit canvas size, stored minus one.
      const u24 = (o: number) =>
        buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
      return { width: u24(24) + 1, height: u24(27) + 1 };
    }
  }

  // JPEG: unlike PNG and WebP there is no fixed offset. Dimensions live in a
  // Start-Of-Frame marker, which sits after a variable run of other segments
  // (JFIF/Exif headers, quantisation tables, comments), so the only way to
  // find it is to walk the segment chain.
  //
  // Worth the extra code rather than letting `.jpg` return null: a caller
  // reads null as "cannot measure", so a screenshot format the build cannot
  // measure is one the minimum-width rule silently stops covering — and JPEG
  // is the format a screenshot is most likely to arrive in.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      // Segments are 0xFF followed by a marker; 0xFF is also the padding byte,
      // so skip any run of them before reading the marker itself.
      if (buf[o] !== 0xff) {
        o++;
        continue;
      }
      let marker = buf[o + 1];
      while (marker === 0xff && o + 2 < buf.length) {
        o++;
        marker = buf[o + 1];
      }

      // Standalone markers carrying no payload: RSTn, SOI, TEM. Nothing to skip.
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        o += 2;
        continue;
      }

      const len = buf.readUInt16BE(o + 2);
      // SOF0–SOF15, excluding DHT (0xC4), JPG (0xC8) and DAC (0xCC), which
      // share the 0xCn range but are not frame headers.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        // Payload: 1 byte precision, then height and width as big-endian uint16.
        return {
          height: buf.readUInt16BE(o + 5),
          width: buf.readUInt16BE(o + 7),
        };
      }

      // A malformed length would otherwise spin here forever.
      if (len < 2) return null;
      o += 2 + len;
    }
  }

  return null;
}

/**
 * Read an SVG's intrinsic size from its root element, without rendering it.
 *
 * An SVG has no pixel header, but it states its size in markup, and the
 * sizing rules are short: an absolute `width` and `height` on the root give the
 * intrinsic size; failing that, `viewBox` gives the aspect ratio, which is all
 * a logo is measured for. Percentages and font-relative units are neither, so
 * they fall through to `viewBox`.
 *
 * Read as text and never executed. Returns null when the root states neither,
 * which the caller reports as "declare a viewBox" rather than guessing a shape.
 */
export function readSvgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;

  // A leading space keeps `width` from matching inside `stroke-width`.
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(root)?.[2];
  const length = (value: string | undefined) => {
    const m = /^\s*(\d*\.?\d+)\s*(px)?\s*$/i.exec(value ?? "");
    const n = m ? Number(m[1]) : NaN;
    return n > 0 ? n : null;
  };

  const width = length(attr("width"));
  const height = length(attr("height"));
  if (width && height) return { width, height };

  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    return { width: box[2], height: box[3] };
  }
  return null;
}
