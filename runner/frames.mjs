/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * The runner protocol's frames (Items 5b and 7b,
 * docs/plans/20261128_0146-out-of-process-runners.md).
 *
 * A frame is a 4-byte big-endian length, then that many bytes of UTF-8 JSON.
 * The platform (src/lib/runners/) and a runner (runner/bootstrap.mjs) share
 * this file, and a runner loads nothing else of the platform's: it may read
 * only this folder and its own bundle. So it is plain JavaScript, with no
 * dependencies.
 *
 * Values are JSON, plus a tagged form for what JSON would lose: a Date, bytes,
 * a bigint and an error. An error crosses as its name, its message and a few
 * named fields, never its stack, so the platform tells a runner no more than a
 * route's caller would see.
 */

/** The largest frame either side accepts. A larger one ends the connection. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const TAG = "$mixos";

/** The fields an error keeps when it crosses: ConnectorError's (src/lib/connectors/errors.ts), and a code. */
const ERROR_FIELDS = [
  "code",
  "status",
  "category",
  "userMessage",
  "adminHint",
  "retryAfter",
  "retryAfterMs",
  "attempts",
  "subject",
  "connectorName",
  "upstreamRequestId",
];

export class FrameError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
}

/** @param {unknown} err */
function errorFields(err) {
  const e = /** @type {Record<string, unknown>} */ (err);
  /** @type {Record<string, unknown>} */
  const out = {
    name: typeof e.name === "string" ? e.name : "Error",
    message: typeof e.message === "string" ? e.message : String(err),
  };
  for (const k of ERROR_FIELDS) {
    const v = e[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * JSON.stringify's replacer sees a Date after its toJSON, so the original is
 * read off the holder.
 * @this {Record<string, unknown>}
 * @param {string} key
 * @param {unknown} value
 */
function replacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return { [TAG]: "date", v: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  if (raw instanceof Uint8Array) {
    return { [TAG]: "bytes", v: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") };
  }
  if (typeof raw === "bigint") return { [TAG]: "bigint", v: raw.toString() };
  if (raw instanceof Error) return { [TAG]: "error", v: errorFields(raw) };
  return value;
}

/**
 * @param {string} _key
 * @param {unknown} value
 */
function reviver(_key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const o = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(o);
  if (keys.length !== 2 || typeof o[TAG] !== "string" || !("v" in o)) return value;
  const v = o.v;
  switch (o[TAG]) {
    case "date":
      if (v === null) return new Date(NaN);
      return typeof v === "string" ? new Date(v) : value;
    case "bytes":
      return typeof v === "string" ? new Uint8Array(Buffer.from(v, "base64")) : value;
    case "bigint":
      return typeof v === "string" && /^-?\d{1,4096}$/.test(v) ? BigInt(v) : value;
    case "error": {
      if (!v || typeof v !== "object") return value;
      const f = /** @type {Record<string, unknown>} */ (v);
      const err = new Error(typeof f.message === "string" ? f.message : "");
      err.name = typeof f.name === "string" ? f.name : "Error";
      for (const k of ERROR_FIELDS) {
        const x = f[k];
        if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
          /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (err))[k] = x;
        }
      }
      return err;
    }
    default:
      return value;
  }
}

/**
 * One message as a frame.
 * @param {Record<string, unknown>} message
 * @returns {Buffer}
 */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message, replacer), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new FrameError(`frame of ${body.length} bytes is over the limit`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Turns a byte stream back into messages. `push` throws a FrameError for a
 * frame over the limit or one that isn't a JSON object, and the side that
 * reads it ends the connection: there is no resynchronising a length-prefixed
 * stream.
 */
export class FrameReader {
  /** @type {Buffer} */
  #buf = Buffer.alloc(0);
  /** @type {(message: Record<string, unknown>) => void} */
  #onFrame;

  /** @param {(message: Record<string, unknown>) => void} onFrame */
  constructor(onFrame) {
    this.#onFrame = onFrame;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    while (this.#buf.length >= 4) {
      const size = this.#buf.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) throw new FrameError(`frame of ${size} bytes is over the limit`);
      if (this.#buf.length < 4 + size) return;
      const body = this.#buf.subarray(4, 4 + size).toString("utf8");
      this.#buf = this.#buf.subarray(4 + size);
      /** @type {unknown} */
      let message;
      try {
        message = JSON.parse(body, reviver);
      } catch {
        throw new FrameError("frame is not JSON");
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new FrameError("frame is not an object");
      }
      this.#onFrame(/** @type {Record<string, unknown>} */ (message));
    }
  }
}
