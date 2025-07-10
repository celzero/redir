// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2023 RethinkDNS and its authors

import * as bin from "./buf.js";
import { hkdfaes, hkdfalgkeysz, sha256, sha512 } from "./hmac.js";
import * as glog from "./log.js";
import { decryptAesGcm, encryptAesGcm } from "./webcrypto.js";

const log = new glog.Log("dbenc", 1);

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} ad - IV nonce (hex string)
 * @param {string} taggedciphertext - to decrypt (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (hex) or null
 */
export async function decrypt(env, cid, ad, taggedciphertext) {
  const enckey = await key(env, cid);
  const iv = await weakiv(ad, cid);
  if (!enckey || !iv) {
    log.e("decrypt: key/iv missing");
    return null;
  }
  try {
    const ct = bin.hex2buf(taggedciphertext);
    const plaintext = await decryptAesGcm(enckey, iv, ct);
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
 * @param {string} aadstr - additional data (string)
 * @param {string} plainstr - plaintext to encrypt (string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex string) or null
 * @throws {Error} - If the plaintext is not a valid string or if encryption fails
 */
export async function encryptText(env, cid, uniq, aadstr, plainstr) {
  const noncehex = bin.str2byt2hex(uniq);
  const aadhex = bin.str2byt2hex(aadstr);
  const pthex = bin.str2byt2hex(plainstr);
  return await encrypt(env, cid, noncehex, aadhex, pthex);
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} uniq - unique nonce (hex string)
 * @param {string} aad - additional data (hex string)
 * @param {string} plaintext - plaintext to encrypt (hex string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex) or null
 */
export async function encrypt(env, cid, uniq, aad, plaintext) {
  const enckey = await key(env, cid, "dbenc");
  const iv = await fixedNonce(uniq, cid);
  if (!enckey || !iv) {
    log.e("encrypt: key/iv missing");
    return null;
  }
  try {
    const pt = bin.hex2buf(plaintext);
    const taggedciphertext = await encryptAesGcm(enckey, iv, aad, pt);
    return bin.buf2hex(taggedciphertext);
  } catch (err) {
    log.e("encrypt: failed", err);
    return null;
  }
}

/**
 *
 * @param {any} env - Worker environment
 * @returns {Promise<CryptoKey|null>} - Returns a CryptoKey or null if the key is missing or invalid
 */
async function key(env, ctx) {
  const seed = env.KDF_SECRET_D1;
  if (!seed) {
    console.error("dbenc: key missing");
    return null;
  }
  return await aeskeygen(seed, ctx);
}

/**
 *
 * @param {string} ad - hex string
 * @param {string} cid - hex string
 * @returns
 */
async function fixedNonce(ad, cid) {
  if (bin.emptyString(ad) || bin.emptyString(cid)) {
    throw new Error("iv: userid/cid missing");
  }
  const ctx = bin.hex2buf(ad + cid);
  const iv = await sha256(ctx);
  return iv.slice(0, 12); // AES-GCM requires a 12-byte IV
}

/**
 * @param {string} seedhex - hex string (64 chars)
 * @param {string} ctxhex - hex string (non-empty)
 * @returns {Promise<CryptoKey?>}
 */
export async function aeskeygen(seedhex, ctxhex) {
  if (!bin.emptyString(seedhex) && !bin.emptyString(ctxhex)) {
    try {
      const sk = bin.hex2buf(seedhex);
      const sk256 = sk.slice(0, hkdfalgkeysz);
      const info512 = await sha512(bin.hex2buf(ctxhex));
      return await gen(sk256, info512); // hdkf aes key
    } catch (ignore) {
      logd("keygen: err", ignore);
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
