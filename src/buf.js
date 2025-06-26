/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

export const ZEROBUF = new Uint8Array(0);

const tencoder = new TextEncoder();
const tdecoder = new TextDecoder();

export function str2byte(s) {
  return tencoder.encode(s);
}

export function byte2str(b) {
  return tdecoder.decode(b);
}

export function str2byt2hex(s) {
  return byt2hex(str2byte(s));
}

export function hex2byt2str(h) {
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
  btoa(String.fromCharCode(byt(buffer)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * @param {string} b64 - base64 (standard)
 * @returns {ArrayBuffer} - returns an ArrayBuffer
 */
export function b642buf(b64) {
  return str2ab(atob(b64));
}

// stackoverflow.com/a/70653061
export function b64AsBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  return new Uint8Array(
    atob(b64)
      .split("")
      .map((c) => c.charCodeAt(0))
  );
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
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function bytcmp(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (b[i] !== a[i]) return false;
  }
  return true;
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

export function emptyString(s) {
  if (typeof s === "string") {
    // todo: trim
    return !s || s.length === 0;
  } else {
    return false;
  }
}
