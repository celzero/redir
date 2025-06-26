/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { b642buf, byt, str2ab } from "./buf.js";

/**
 *
 * @param {CryptoKey} key
 * @param {BufferSource} iv
 * @param {BufferSource} taggedciphertext
 * @returns
 */
export async function decryptAesGcm(aeskey, iv, taggedciphertext) {
  const plaintext = crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128, // default (in bits)
    },
    aeskey,
    taggedciphertext
  );
  return byt(plaintext);
}

/**
 *
 * @param {BufferSource} aeskey
 * @param {BufferSource} iv
 * @param {BufferSource} plaintext
 * @returns {Promise<Uint8Array>}
 */
export async function encryptAesGcm(aeskey, iv, plaintext) {
  const taggedciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128, // default (in bits)
    },
    aeskey,
    plaintext
  );
  return byt(taggedciphertext);
}

/**
 *
 * @param {Uint8Array} raw
 * @returns {Promise<CryptoKey>}
 */
export function importAes256Key(raw) {
  return crypto.subtle.importKey(
    "raw",
    raw,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * @param {Uint8Array} raw
 * @returns {Promise<CryptoKey>}
 */
export function importHmacKey(raw) {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * @param {CryptoKey} key
 * @param {Uint8Array} msg
 */
export function hmacsign(key, msg) {
  return crypto.subtle.sign("HMAC", key, msg);
}

export async function importRsaPssPubKey(pubjwkstr) {
  return crypto.subtle.importKey(
    "jwk",
    pubjwkstr,
    {
      name: "RSA-PSS",
      hash: { name: "SHA-384" },
    },
    true,
    ["verify"]
  );
}

/**
 * @param {Uint8Array} m
 * @returns {Promise<Uint8Array>}
 */
export async function sha256(m) {
  const x = await crypto.subtle.digest("SHA-256", m);
  return byt(x);
}

/**
 * @param {Uint8Array} m
 * @returns {Promise<Uint8Array>}
 */
export function crand(n = 32) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * @param {number} n
 * @returns {string} Hex string of length n
 */
export function crandHex(n = 64) {
  // b as hex string
  return Array.from(crand(n / 2), (byt) =>
    byt.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Sign a string using RSASSA-PKCS1-v1_5 with SHA-256
 * and return the signature.
 * @param {string} content
 * @param {string} signingKey
 * @returns {Promise<ArrayBuffer>} - Returns the binary signature.
 */
export async function rsaSsaSign(content, signingKey) {
  const buf = str2ab(content);
  const key = await importRsaSsa256Key(signingKey);
  return await crypto.subtle.sign({ name: "RSASSA-PKCS1-V1_5" }, key, buf);
}

/**
 * @param {string} pem - PEM formatted private key
 * @returns {Promise<CryptoKey>} - Returns a CryptoKey for RSASSA-PKCS1-v1_5 with SHA-256
 */
export async function importRsaSsa256Key(pem) {
  const plainKey = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/(\r\n|\n|\r)/gm, "");
  const binaryKey = b642buf(plainKey);
  return await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    {
      name: "RSASSA-PKCS1-V1_5",
      hash: { name: "SHA-256" },
    },
    false,
    ["sign"]
  );
}
