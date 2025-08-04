/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as glog from "./log.js";

export const ZEROBUF = new Uint8Array(0);

const tencoder = new TextEncoder();
const tdecoder = new TextDecoder();

const log = new glog.Log("buf");

export function str2byte(s) {
  return tencoder.encode(s);
}

export function byte2str(b) {
  return tdecoder.decode(b);
}

/**
 * @param {string} s - UTF-8 encoded string
 * @returns {string} - s encoded to bytes and then to hex
 * @see {@link hex2byt2str}
 */
export function str2byt2hex(s) {
  if (emptyString(s)) return "";
  return buf2hex(str2byte(s));
}

/**
 * @param {string} h - hex encoded string
 * @returns {string} - h decoded to bytes and then to UTF-8
 * @see {@link str2byt2hex}
 */
export function hex2byt2str(h) {
  if (emptyString(h)) return "";
  return byte2str(hex2buf(h));
}

/**
 * @param {string} str (UTF-8 encoded string)
 * @returns {ArrayBuffer}
 */
export function str2ab(str) {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i += 1) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string} - base64url encoded string
 */
export function buf2b64url(buffer) {
  if (emptyBuf(buffer)) return "";
  return btoa(String.fromCharCode(...byt(buffer)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 *
 * @param  {...BufferSource} args - Concatenates multiple BufferSources into a single Uint8Array
 * @returns {Uint8Array} - Concatenated Uint8Array
 */
export function cat(...args) {
  if (args.length === 0) return ZEROBUF;
  if (args.length === 1) return byt(args[0]);
  const totalLength = args.reduce((sum, arg) => sum + arg.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arg of args) {
    if (emptyBuf(arg)) continue; // skip empty buffers
    const view = byt(arg);
    result.set(view, offset);
    offset += view.byteLength;
  }
  return result;
}

/**
 * @param {string} b64 - base64 (standard)
 * @returns {ArrayBuffer} - returns an ArrayBuffer
 */
export function b642buf(b64) {
  if (emptyString(b64)) return ZEROBUF.buffer;
  try {
    return str2ab(atob(b64));
  } catch (e) {
    log.e(`b642buf: failed to decode ${b64} base64: ${e.message}`, e);
    return ZEROBUF.buffer;
  }
}

// stackoverflow.com/a/70653061
export function b64AsBytes(b64url) {
  if (emptyString(b64url)) return ZEROBUF;
  try {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
    return new Uint8Array(
      atob(b64)
        .split("")
        .map((c) => c.charCodeAt(0))
    );
  } catch (e) {
    log.e(`b64AsBytes: failed to decode ${b64url} base64url: ${e.message}`, e);
    return ZEROBUF;
  }
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function bytcmp(a, b) {
  const aempty = emptyBuf(a);
  const bempty = emptyBuf(b);
  if (aempty && bempty) return true; // both empty
  if (aempty || bempty) return false; // one is empty, the other
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (b[i] !== a[i]) return false;
  }
  return true;
}

/**
 * Check if Buffer is empty
 * @param {ArrayBuffer|Buffer} b
 * @returns {boolean}
 */
export function emptyBuf(b) {
  return !b || b.byteLength === 0;
}

/**
 * Given a buffer b, returns the underlying array buffer
 * @param {ArrayBuffer|Buffer} b
 * @returns {ArrayBuffer}
 */
function raw(b) {
  if (emptyBuf(b)) return ZEROBUF.buffer;
  if (b instanceof ArrayBuffer) return b;
  return b.buffer;
}

/**
 * Given a buffer b, returns its uint8array view
 * @param {ArrayBuffer|Uint8Array} b
 * @returns {Uint8Array}
 */
export function byt(b) {
  if (emptyBuf(b)) return ZEROBUF;
  const ab = raw(b);
  return new Uint8Array(ab);
}

/**
 * @param {ArrayBuffer|Uint8Array} b
 * @returns {string}
 */
export function buf2hex(b) {
  if (emptyBuf(b)) return "";
  const u8 = byt(b);
  return Array.from(u8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {string} h
 * @returns {Uint8Array}
 */
export function hex2buf(h) {
  if (emptyString(h)) return ZEROBUF;
  return new Uint8Array(h.match(/.{1,2}/g).map((w) => parseInt(w, 16)));
}

/**
 * @param {String} s
 * @returns {boolean} - true if the string is empty or null
 */
export function emptyString(s) {
  if (s == null) return true; // null or undefined
  if (typeof s === "string") {
    // todo: trim
    return !s || s.length === 0;
  } else {
    return false;
  }
}
