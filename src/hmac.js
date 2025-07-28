// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors.

import * as bin from "./buf.js";

/**
 * IKM must be at least as many bytes as the hash fn (sha256 for hmac256)
 *for hkdf256 to hold dual PRF:
 * blog.trailofbits.com/2025/01/28/best-practices-for-key-derivation/
 * @type {number}
 */
export const hkdfalgkeysz = 32; // sha256

/**
 * AES-GCM IV size in bytes
 * 12 bytes is the recommended size for AES-GCM IV
 */
export const aesivsz = 12; // AES-GCM IV size

export function rand(sz = 16) {
  const t = new Uint8Array(sz);
  crypto.getRandomValues(t);
  return t;
}

/**
 * @param {CryptoKey} ck - The HMAC key
 * @param {BufferSource} m - message to sign
 * @returns {Promise<ArrayBuffer>} - The HMAC signature
 * @throws {Error} - If the key is not valid or signing fails
 */
export async function hmacsign(ck, m) {
  return crypto.subtle.sign("HMAC", ck, m);
}

/**
 * @param {CryptoKey} ck - The HMAC key
 * @param {ArrayBuffer} mac - The HMAC signature to verify
 * @param {BufferSource} m - The message to verify against
 * @returns {Promise<boolean>} - True if the signature is valid, false otherwise
 * @throws {Error} - If the key is not valid or verification fails
 */
export async function hmacverify(ck, mac, m) {
  return crypto.subtle.verify("HMAC", ck, mac, m);
}

// with hkdf, salt is optional and public, but if used,
// for a given secret (Z) it needn't be unique per use,
// but it *must* be random:
// cendyne.dev/posts/2023-01-30-how-to-use-hkdf.html
// info adds entropy to extracted keys, and must be unique:
// see: soatok.blog/2021/11/17/understanding-hkdf
export async function hkdfaes(skmac, usectx, salt = bin.ZEROBUF) {
  const dk = await hkdf(skmac);
  return crypto.subtle.deriveKey(
    hkdf256(salt, usectx),
    dk,
    aesgcm256opts(),
    true, // extractable? can be true for sign, verify
    ["encrypt", "decrypt"] // usage
  );
}

export async function hmackey(sk) {
  return crypto.subtle.importKey(
    "raw",
    sk,
    hmac256opts(),
    false, // extractable? always false for use as derivedKey
    ["sign", "verify"] // usage
  );
}

export async function hkdf(sk) {
  return crypto.subtle.importKey(
    "raw",
    sk,
    "HKDF",
    false, // extractable? always false for use as derivedKey
    ["deriveKey", "deriveBits"] // usage
  );
}

export function hmac256opts() {
  return { name: "HMAC", hash: "SHA-256" };
}

/**
 * https://developer.mozilla.org/en-US/docs/Web/API/AesKeyGenParams
 * @returns {AesKeyGenParams}
 */
export function aesgcm256opts() {
  return {
    name: "AES-GCM",
    length: 256,
  };
}

export function hkdf256(salt, usectx) {
  return { name: "HKDF", hash: "SHA-256", salt: salt, info: usectx };
}

export async function sha256(b) {
  const ab = await crypto.subtle.digest("SHA-256", b);
  return bin.byt(ab);
}

export async function sha512(b) {
  const ab = await crypto.subtle.digest("SHA-512", b);
  return bin.byt(ab);
}
