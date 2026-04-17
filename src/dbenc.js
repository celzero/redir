// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2023 RethinkDNS and its authors

import * as bin from "./buf.js";
import { hkdfaes, hkdfalgkeysz, sha256, sha512 } from "./hmac.js";
import * as glog from "./log.js";
import { csprng, decryptAesGcm, encryptAesGcm } from "./webcrypto.js";

const log = new glog.Log("dbenc");

// 11 July 2024 (1752256401335) or 22 Mar 2026 (1774128919000)
export const aadRequirementStartTime = 1752256401335;

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} uniq - uniq nonce (hex string)
 * @param {string?} aadhex - additional data, ideally tablename+colname (hex string)
 * @param {string} taggedciphertext - to decrypt (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (hex) or null
 */
export async function decrypt(env, cid, uniq, aadhex, taggedciphertext) {
  if (bin.emptyString(cid) || bin.emptyString(uniq)) {
    log.e("decrypt: cid/uniq missing");
    return null;
  }
  let keyctx = "";
  if (!bin.emptyString(aadhex)) {
    // do not use ctx if aad is missing (see: dbenc.aadRequirementStartTime)
    keyctx = "dbenc";
  }
  const enckey = await key(env, cid, keyctx);
  const iv = await fixedNonce(uniq, cid);
  if (!enckey || !iv) {
    log.e("decrypt: key/iv missing");
    return null;
  }
  try {
    const cipher = bin.hex2buf(taggedciphertext);
    const aad = bin.hex2buf(aadhex ?? "");
    const plaintext = await decryptAesGcm(enckey, iv, cipher, aad);
    return bin.buf2hex(plaintext);
  } catch (err) {
    log.e("decrypt: failed", err);
    return null;
  }
}

/**
 * Encrypts plaintext into a tagged ciphertext using AES-GCM.
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} uniq - unique nonce (string)
 * @param {string?} aadstr - additional data (string)
 * @param {string} plainstr - plaintext to encrypt (string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex string) or null
 * @throws {Error} - If the plaintext is not a valid string or if encryption fails
 */
export async function encryptText(env, cid, uniq, aadstr, plainstr) {
  if (bin.emptyString(plainstr)) {
    log.e("encryptText: plaintext missing");
    return null;
  }

  const noncehex = bin.str2byt2hex(uniq);
  const aadhex = bin.str2byt2hex(aadstr ?? ""); // optional, may be empty
  const pthex = bin.str2byt2hex(plainstr);
  return await encrypt(env, cid, noncehex, aadhex, pthex);
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} uniq - unique nonce (hex string)
 * @param {string?} aadhex - additional data (hex string)
 * @param {string} plaintext - plaintext to encrypt (hex string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex) or null
 */
export async function encrypt(env, cid, uniq, aadhex, plaintext) {
  if (bin.emptyString(cid) || bin.emptyString(uniq)) {
    log.e("encrypt: cid/uniq missing");
    return null;
  }
  let keyctx = "";
  if (!bin.emptyString(aadhex)) {
    // do not use ctx if aad is missing (see: dbenc.aadRequirementStartTime)
    keyctx = "dbenc";
  }
  const enckey = await key(env, cid, keyctx);
  const iv = await fixedNonce(uniq, cid);
  if (!enckey || !iv) {
    log.e("encrypt: key/iv missing");
    return null;
  }
  try {
    const pt = bin.hex2buf(plaintext);
    const aad = bin.hex2buf(aadhex ?? "");
    const taggedciphertext = await encryptAesGcm(enckey, iv, pt, aad);
    return bin.buf2hex(taggedciphertext);
  } catch (err) {
    log.e("encrypt: failed", err);
    return null;
  }
}

/**
 * Encrypts plaintext using AES-GCM with a random IV, prepending the IV to the
 * output so no separate nonce storage is required.  Unlike {@link encrypt}
 * (which derives a fixed IV from uniq+cid), the IV here is generated randomly.
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string?} aadhex - additional authenticated data (hex string)
 * @param {string} plaintext - plaintext to encrypt (hex string)
 * @returns {Promise<string|null>} - iv (12 B) ‖ taggedciphertext, encoded as hex, or null
 */
export async function encrypt2(env, cid, aadhex, plaintext) {
  let keyctx = "";
  if (!bin.emptyString(aadhex)) {
    keyctx = "dbenc2";
  }
  const enckey = await key(env, cid, keyctx);
  if (!enckey) {
    log.e("encrypt2: key missing");
    return null;
  }
  try {
    const iv = csprng(12); // random 12-byte IV
    const pt = bin.hex2buf(plaintext);
    const aad = bin.hex2buf(aadhex ?? "");
    const tagged = await encryptAesGcm(enckey, iv, pt, aad);
    // prepend iv: ivtaggedciphertext = iv ‖ taggedciphertext
    const out = new Uint8Array(iv.byteLength + tagged.byteLength);
    out.set(iv, 0);
    out.set(tagged, iv.byteLength);
    return bin.buf2hex(out);
  } catch (err) {
    log.e("encrypt2: failed", err);
    return null;
  }
}

/**
 * Decrypts an ivtaggedciphertext produced by {@link encrypt2}.
 * The first 12 bytes of the ciphertext are the IV; the rest is the AES-GCM
 * tagged ciphertext.
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string?} aadhex - additional authenticated data (hex string)
 * @param {string} ivtaggedciphertext - iv ‖ taggedciphertext (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (hex) or null
 */
export async function decrypt2(env, cid, aadhex, ivtaggedciphertext) {
  let keyctx = "";
  if (!bin.emptyString(aadhex)) {
    keyctx = "dbenc2";
  }
  const enckey = await key(env, cid, keyctx);
  if (!enckey) {
    log.e("decrypt2: key missing");
    return null;
  }
  try {
    const combined = bin.hex2buf(ivtaggedciphertext);
    // minimum: 12 (IV) + 16 (AES-GCM auth tag) = 28 bytes for empty plaintext
    if (combined.byteLength < 28) {
      throw new Error("decrypt2: data too short to contain IV + auth tag");
    }
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const aad = bin.hex2buf(aadhex ?? "");
    const plaintext = await decryptAesGcm(enckey, iv, cipher, aad);
    return bin.buf2hex(plaintext);
  } catch (err) {
    log.e("decrypt2: failed", err);
    return null;
  }
}

/**
 * String-level wrapper around {@link encrypt2}.
 * Converts plainstr and aadstr to hex, encrypts with a random IV, and returns
 * the resulting ivtaggedciphertext hex string.
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string?} aadstr - additional authenticated data (string)
 * @param {string} plainstr - plaintext to encrypt (string)
 * @returns {Promise<string|null>} - ivtaggedciphertext (hex) or null
 */
export async function encryptText2(env, cid, aadstr, plainstr) {
  if (bin.emptyString(plainstr)) {
    log.e("encryptText2: plaintext missing");
    return null;
  }
  const aadhex = bin.str2byt2hex(aadstr ?? ""); // optional, may be empty
  const pthex = bin.str2byt2hex(plainstr);
  return await encrypt2(env, cid, aadhex, pthex);
}

/**
 * String-level wrapper around {@link decrypt2}.
 * Decrypts an ivtaggedciphertext hex string and returns the plaintext as UTF-8.
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string?} aadstr - additional authenticated data (string)
 * @param {string} ivtaggedciphertext - iv ‖ taggedciphertext (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (UTF-8 string) or null
 */
export async function decryptText2(env, cid, aadstr, ivtaggedciphertext) {
  const aadhex = bin.str2byt2hex(aadstr ?? "");
  const plainhex = await decrypt2(env, cid, aadhex, ivtaggedciphertext);
  if (bin.emptyString(plainhex)) return null;
  try {
    return bin.hex2byt2str(plainhex);
  } catch (err) {
    log.e("decryptText2: failed decode hex2str", err);
  }
  return null;
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string?} ctxstr - context for key generation (string)
 * @returns {Promise<CryptoKey|null>} - Returns a CryptoKey or null if the key is missing or invalid
 */
async function key(env, cid, ctxstr = "") {
  if (bin.emptyString(cid)) {
    log.e("key: cid missing");
    return null;
  }
  const seed = env.KDF_SECRET_D1;
  if (!seed) {
    log.e("key missing");
    return null;
  }
  const ctxhex = bin.str2byt2hex(ctxstr); // ctxhex may be empty string
  return await aeskeygen(seed, cid, ctxhex);
}

/**
 * @param {string} lo - hex string
 * @param {string} hi - hex string
 * @returns {Promise<Uint8Array>} - 12-byte fixed nonce
 */
async function fixedNonce(lo, hi) {
  if (bin.emptyString(lo) || bin.emptyString(hi)) {
    throw new Error("iv: lo/hi missing");
  }
  const ctx = bin.hex2buf(lo + hi);
  const iv = await sha256(ctx);
  return iv.slice(0, 12); // AES-GCM requires a 12-byte IV
}

/**
 * @param {string} seedhex - hex string (64 chars)
 * @param {string} cid - Client ID (hex string)
 * @param {string} ctxhex - key context (hex string)
 * @returns {Promise<CryptoKey?>}
 */
export async function aeskeygen(seedhex, cid, ctxhex) {
  ctxhex = ctxhex || "";
  if (!bin.emptyString(seedhex) && !bin.emptyString(cid)) {
    try {
      const sk = bin.hex2buf(seedhex);
      if (sk.length < hkdfalgkeysz) {
        log.e("keygen: seed too short", sk.length, hkdfalgkeysz);
        return null;
      }

      const sk256 = sk.slice(0, hkdfalgkeysz);
      // info must always of a fixed size for ALL KDF calls
      const info512 = await sha512(bin.hex2buf(cid + ctxhex));
      return await gen(sk256, info512); // hdkf aes key
    } catch (ignore) {
      log.d("keygen: err", ignore);
    }
  }
  log.d("keygen: invalid seed/ctx");
  return null;
}

/**
 * salt for hkdf can be zero: stackoverflow.com/a/64403302
 * @param {Uint8Array} secret - The secret key to derive from
 * @param {Uint8Array} info - The context information to use for key derivation
 * @param {Uint8Array} [salt=bin.ZEROBUF] - Optional
 */
async function gen(secret, info, salt = bin.ZEROBUF) {
  if (bin.emptyBuf(secret) || bin.emptyBuf(info)) {
    throw new Error("empty secret/info");
  }
  // exportable: crypto.subtle.exportKey("raw", key);
  return hkdfaes(secret, info, salt);
}
