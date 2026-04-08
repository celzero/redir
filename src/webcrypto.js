/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  ZEROBUF,
  b642buf,
  buf2hex,
  byt,
  emptyBuf,
  hex2buf,
  lcat,
  str2ab,
  str2byt2hex,
} from "./buf.js";

/**
 * @param {CryptoKey} aeskey - The AES-GCM key
 * @param {BufferSource} iv - The initialization vector (12 byte)
 * @param {BufferSource} taggedciphertext - The encrypted data with authentication tag
 * @param {BufferSource?} aad - Additional authenticated data (AAD)
 * @returns {Promise<Uint8Array>} - The decrypted plaintext
 */
export async function decryptAesGcm(aeskey, iv, taggedciphertext, aad) {
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
    taggedciphertext,
  );
  return byt(plaintext);
}

/**
 * @param {BufferSource} aeskey - The AES-GCM key
 * @param {BufferSource} iv - The initialization vector (12 byte)
 * @param {BufferSource} plaintext - The data to encrypt
 * @param {BufferSource?} aad - Additional authenticated data (AAD)
 * @returns {Promise<Uint8Array>} - The encrypted data with authentication tag
 */
export async function encryptAesGcm(aeskey, iv, plaintext, aad) {
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
    plaintext,
  );
  return byt(taggedciphertext);
}

/**
 * @param {BufferSource} aeskey - The AES-CBC key
 * @param {BufferSource} hmackey - The HMAC key
 * @param {BufferSource} iv - The initialization vector (16 byte / 128 bit for AES-CBC)
 * @param {BufferSource} plaintext - The data to encrypt
 * @param {BufferSource?} aad - Additional authenticated data (AAD)
 * @returns {Promise<[Uint8Array]>} - The encrypted data with authentication tag
 */
export async function encryptAesCbcHmac(aeskey, hmackey, iv, plaintext, aad) {
  /** @type {AesCbcParams} */
  const params = {
    name: "AES-CBC",
    iv: iv, // 128 bit (16 byte) IV
  };

  // auto-adds PKCS#7 padding to plaintext
  const ciphertext = await crypto.subtle.encrypt(params, aeskey, plaintext);
  // lcat (length-prefixed concatenation) is required here because both
  // ciphertext and aad are variable-length. With plain cat(), an attacker
  // could shift bytes between ciphertext and aad and produce a different
  // (ciphertext', aad') pair with an identical flat MAC input, forging
  // authentication for data they did not encrypt.
  // IV is bound into the MAC to prevent CBC IV-flipping: flipping IV bits
  // silently corrupts the first plaintext block but would not fail the MAC
  // unless the IV is authenticated here.
  // Absent aad is treated as zero-length bytes so the MAC is always well-formed
  // (passing undefined to cat() crashes in the reduce; lcat avoids that too).
  const aadBytes = !aad || emptyBuf(aad) ? ZEROBUF : byt(aad);
  const mac = await hmacsign(hmackey, lcat(iv, ciphertext, aadBytes)); // 32 bytes

  return [ciphertext, mac];
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
    ["encrypt", "decrypt"],
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
    ["sign"],
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
    ["verify"],
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
    byt.toString(16).padStart(2, "0"),
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
  return crypto.subtle.sign({ name: "RSASSA-PKCS1-V1_5" }, key, buf);
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
    ["sign"],
  );
}

/**
 * Obfuscates a string using SHA-256. Converts str to a utf-8 byte array,
 * then hashes it to a hex string.
 * @param {string} str - input string to obfuscate.
 * @returns {Promise<string>} - sha256 hash of the input as hex.
 */
export async function obfuscate(str) {
  const hex = str2byt2hex(str);
  return obfuscateHex(hex);
}

/**
 * Obfuscates a string using SHA-256. Converts str to a utf-8 byte array,
 * then hashes it to a hex string.
 * @param {string} hex - input shex string to obfuscate.
 * @returns {Promise<string>} - sha256 hash of the input as hex.
 */
export async function obfuscateHex(hexstr) {
  return sha256hex(hexstr);
}

/**
 * Generates cryptographically secure random bytes.
 * @param {number} len - The number of random bytes to generate (default: 32)
 * @returns {Uint8Array} - A Uint8Array containing the random bytes
 */
export function csprng(len = 12) {
  if (isNaN(len) || len <= 0) {
    throw new Error("csprng: invalid argument");
  }
  return crypto.getRandomValues(new Uint8Array(len));
}
