// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import { aesivsz, hkdfaes, hkdfalgkeysz, sha512 } from "./hmac.js";
import * as glog from "./log.js";
import { crand, decryptAesGcm, encryptAesGcm } from "./webcrypto.js";

const log = new glog.Log("dbenc");

const ctx2 = bin.str2byte("encryptforclient");

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} ivtaggedciphertext - to decrypt (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (hex) or null
 */
export async function decrypt(env, cid, ivtaggedciphertext) {
  if (bin.emptyString(cid)) {
    log.e("decrypt: cid missing");
    return null;
  }
  const enckey = await clientkey(env, bin.hex2buf(cid), ctx2);
  if (!enckey || !iv) {
    log.e("decrypt: key/iv missing");
    return null;
  }
  try {
    const fullcipher = bin.hex2buf(ivtaggedciphertext);
    const iv = fullcipher.slice(0, aesivsz);
    const cipher = fullcipher.slice(aesivsz);
    const plaintext = await decryptAesGcm(enckey, iv, null, cipher);
    return bin.buf2hex(plaintext);
  } catch (err) {
    log.e("decrypt: failed", err);
    return null;
  }
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} ivtaggedciphertext - to decrypt (hex string)
 * @returns {Promise<string|null>} - decrypted plaintext (utf8) or null
 */
export async function decryptText(env, cid, ivtaggedciphertext) {
  const plainhex = decrypt(env, cid, ivtaggedciphertext);
  if (emptyString(plainhex)) {
    return plainhex;
  }
  try {
    return bin.hex2byt2str(plainhex);
  } catch (err) {
    log.e("decryptText: failed to decode hex to string", err);
  }
  return null;
}

/**
 * Encrypts plaintext into a tagged ciphertext using AES-GCM.
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} plainstr - plaintext to encrypt (string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex string) or null
 * @throws {Error} - If the plaintext is not a valid string or if encryption fails
 */
export async function encryptText(env, cid, plainstr) {
  const pthex = bin.str2byt2hex(plainstr);
  return await encrypt(env, cid, pthex);
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} plaintext - plaintext to encrypt (hex string)
 * @returns {Promise<string|null>} - encrypted tagged ciphertext (hex) or null
 */
export async function encrypt(env, cid, plaintext) {
  const iv = crand(aesivsz);
  const enckey = await clientkey(env, bin.hex2buf(cid), ctx2);
  if (!enckey || !iv) {
    log.e("encrypt: key/iv missing");
    return null;
  }
  try {
    const pt = bin.hex2buf(plaintext);
    const taggedcipher = await encryptAesGcm(enckey, iv, pt);
    return bin.buf2hex(bin.cat(iv, taggedcipher));
  } catch (err) {
    log.e("encrypt: failed", err);
    return null;
  }
}

/**
 *
 * @param {any} env - Worker environment
 * @param {BufferSource} ctx1 - keying context 1 (from client)
 * @param {BufferSource} ctx2 - keying context 2
 * @returns {Promise<CryptoKey|null>} - Returns a CryptoKey or null if the key is missing or invalid
 */
async function clientkey(env, ctx1, ctx2) {
  if (bin.emptyBuf(ctx1) || bin.emptyBuf(ctx2)) {
    log.e("key: ctx missing");
    return null;
  }
  const seed = env.KDF_SECRET_CLIENT;
  if (!seed) {
    log.e("key: KDF_SECRET_CLIENT missing");
    return null;
  }
  const skm = bin.hex2buf(seed);
  return aesclientkey(skm, ctx1, ctx2);
}

/**
 * @param {BufferSource} sk - secret keying material
 * @param {BufferSource} ctx1 - key context 1
 * @param {BufferSource} ctx2 - key context 2
 * @returns {Promise<CryptoKey?>}
 */
async function aesclientkey(sk, ctx1, ctx2) {
  ctxhex = ctxhex || "";
  if (!bin.emptyBuf(sk) && !bin.emptyBuf(ctx1) && !bin.emptyBuf(ctx2)) {
    try {
      if (sk.length < hkdfalgkeysz) {
        log.e("keygen: seed too short", sk.length, hkdfalgkeysz);
        return null;
      }

      const sk256 = sk.slice(0, hkdfalgkeysz);
      // info must always of a fixed size for ALL KDF calls
      const info512 = await sha512(bin.cat(ctx1, ctx2));
      // exportable: crypto.subtle.exportKey("raw", key);
      return hkdfaes(secret, info);
    } catch (ignore) {
      log.d("keygen: err", ignore);
    }
  }
  log.d("keygen: invalid seed/ctx");
  return null;
}
