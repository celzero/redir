/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { b642buf, buf2hex, byt, emptyBuf, hex2buf, str2ab } from "./buf.js";

/**
 * @param {CryptoKey} aeskey - The AES-GCM key
 * @param {BufferSource} iv - The initialization vector
 * @param {BufferSource} aad - Additional authenticated data (AAD)
 * @param {BufferSource} taggedciphertext - The encrypted data with authentication tag
 * @returns {Promise<Uint8Array>} - The decrypted plaintext
 */
export async function decryptAesGcm(aeskey, iv, aad, taggedciphertext) {
  if (!aad || emptyBuf(aad)) {
    aad = undefined; // ZEROBUF is not the same as null?
  }
  /** @type {AesGcmParams} */
  const params = {
    name: "AES-GCM",
    iv: iv, // 96 bit (12 byte) nonce
    additionalData: aad, // optional
    tagLength: 128, // default (in bits)
  };
  const plaintext = await crypto.subtle.decrypt(
    params,
    aeskey,
    taggedciphertext
  );
  return byt(plaintext);
}

/**
 * @param {BufferSource} aeskey - The AES-GCM key
 * @param {BufferSource} iv - The initialization vector
 * @param {BufferSource} aad - Additional authenticated data (AAD)
 * @param {BufferSource} plaintext - The data to encrypt
 * @returns {Promise<Uint8Array>} - The encrypted data with authentication tag
 */
export async function encryptAesGcm(aeskey, iv, aad, plaintext) {
  if (!aad || emptyBuf(aad)) {
    aad = undefined; // ZEROBUF is not the same as null?
  }
  /** @type {AesGcmParams} */
  const params = {
    name: "AES-GCM",
    iv: iv, // 96 bit (12 byte) nonce
    additionalData: aad, // optional
    tagLength: 128, // default (in bits)
  };
  const taggedciphertext = await crypto.subtle.encrypt(
    params,
    aeskey,
    plaintext
  );
  return byt(taggedciphertext);
}

/**
 * @param {Uint8Array} raw - The raw key material (32 bytes for AES-256)
 * @returns {Promise<CryptoKey>} - The imported AES-GCM key
 */
export function importAes256Key(raw) {
  if (!raw || raw.length !== 32) {
    throw new Error("AES-256 key must be exactly 32 bytes");
  }
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
 * @param {Uint8Array} raw - The raw key material for HMAC
 * @returns {Promise<CryptoKey>} - The imported HMAC key
 */
export function importHmacKey(raw) {
  if (!raw || raw.length === 0) {
    throw new Error("HMAC key cannot be empty");
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * @param {CryptoKey} key - The HMAC key
 * @param {Uint8Array} msg - The message to sign
 * @returns {Promise<ArrayBuffer>} - The HMAC signature
 */
export function hmacsign(key, msg) {
  return crypto.subtle.sign("HMAC", key, msg);
}

/**
 * @param {object} pubjwkstr - The JWK public key object
 * @returns {Promise<CryptoKey>} - The imported RSA-PSS public key
 */
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
 * @param {string} m - hex string to hash
 * @returns {Promise<string>} - Returns the SHA-256 hash of the string as a hex string
 */
export async function sha256hex(m) {
  const u8 = await sha256(hex2buf(m));
  return buf2hex(u8);
}

/**
 * @param {number} n - Number of bytes to generate (default: 32)
 * @returns {Uint8Array} - Random bytes
 */
export function crand(n = 32) {
  if (n <= 0) {
    throw new Error("n must be a positive number");
  }
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * @param {number} n - Number of hex characters to generate (default: 64)
 * @returns {string} - Hex string of length n
 */
export function crandHex(n = 64) {
  if (n <= 0 || n % 2 !== 0) {
    throw new Error("n must be a positive even number");
  }
  // b as hex string
  return Array.from(crand(n / 2), (byt) =>
    byt.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Sign a string using RSASSA-PKCS1-v1_5 with SHA-256
 * and return the signature.
 * @param {string} content - The content to sign
 * @param {string} signingKey - PEM formatted private key
 * @returns {Promise<ArrayBuffer>} - Returns the binary signature.
 */
export async function rsaSsaSign(content, signingKey) {
  if (!content || typeof content !== "string") {
    throw new Error("Content must be a non-empty string");
  }
  if (!signingKey || typeof signingKey !== "string") {
    throw new Error("Signing key must be a non-empty string");
  }

  const buf = str2ab(content);
  const key = await importRsaSsa256Key(signingKey);
  return await crypto.subtle.sign({ name: "RSASSA-PKCS1-V1_5" }, key, buf);
}

/**
 * @param {string} pem - PEM formatted private key
 * @returns {Promise<CryptoKey>} - Returns a CryptoKey for RSASSA-PKCS1-v1_5 with SHA-256
 */
export async function importRsaSsa256Key(pem) {
  if (!pem || typeof pem !== "string") {
    throw new Error("PEM key must be a non-empty string");
  }

  // github.com/Schachte/cloudflare-google-auth/blob/fc62a5e683d5c3/index.ts#L84
  const plainKey = pem
    .replace(/\\n/g, "")
    .replace(/(\r\n|\n|\r)/gm, "")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .trim();

  if (!plainKey) {
    throw new Error("Invalid PEM format: no key data found");
  }

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
