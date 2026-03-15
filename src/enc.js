// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import { workersEnv } from "./d.js";
import { aesivsz, hkdfaes, hkdfalgkeysz, sha512 } from "./hmac.js";
import * as glog from "./log.js";
import { crand, decryptAesGcm, encryptAesGcm } from "./webcrypto.js";

const log = new glog.Log("dbenc");

const ctx2 = bin.str2byte("encryptforclient");

const clienthmackeyctx2 = bin.str2byte("clienthmacauthkey");

const clienthmackeysalt = new Uint8Array([
  38, 160, 252, 182, 155, 213, 11, 24, 145, 181, 17, 50, 5, 186, 88, 121, 253,
  55, 234, 238, 24, 15, 54, 144, 176, 249, 180, 142, 66, 88, 52, 80, 219, 142,
  247, 220, 54, 75, 237, 134, 44, 2, 31, 80, 76, 177, 111, 187, 224, 138, 103,
  165, 189, 33, 159, 131, 15, 166, 191, 201, 219, 161, 3, 144,
]);

/**
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
  if (!enckey || !ivtaggedciphertext) {
    log.e("decrypt: key/ivtaggedciphertext missing");
    return null;
  }
  try {
    const fullcipher = bin.hex2buf(ivtaggedciphertext);
    const iv = fullcipher.slice(0, aesivsz);
    const cipher = fullcipher.slice(aesivsz);
    const plaintext = await decryptAesGcm(enckey, iv, cipher);
    return bin.buf2hex(plaintext);
  } catch (err) {
    log.e("decrypt: failed for " + ivtaggedciphertext, err);
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
  const plainhex = await decrypt(env, cid, ivtaggedciphertext);
  if (bin.emptyString(plainhex)) {
    return plainhex;
  }
  try {
    return bin.hex2byt2str(plainhex);
  } catch (err) {
    log.e("decryptText: failed decode hex2str " + ivtaggedciphertext, err);
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

  return aesclientkey(skseed(env), ctx1, ctx2);
}

/**
 * @param {any} env - Worker environment
 * @returns {Uint8Array} - client secret seed
 */
function skseed(env) {
  env = !env ? workersEnv() : env;
  // same secret across test domain and regular domain
  const seed = env.KDF_SECRET_CLIENT;
  if (!seed) {
    log.e("key: KDF_SECRET_CLIENT missing");
    return null;
  }
  return bin.hex2buf(seed);
}

/**
 * @param {ArrayBufferLike} sk - secret keying material
 * @param {BufferSource} ctx1 - key context 1
 * @param {BufferSource} ctx2 - key context 2
 * @returns {Promise<CryptoKey?>}
 */
async function aesclientkey(sk, ctx1, ctx2) {
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
      return hkdfaes(sk256, info512);
    } catch (ignore) {
      log.d("keygen: err", ignore);
    }
  }
  log.d("keygen: invalid seed/ctx");
  return null;
}

/**
 * Generates an HMAC client key using the provided context and environment.
 * @param {any} env - Worker environment
 * @param {BufferSource} ctx1 - keying context 1 (from client)
 * @param {boolean} test - whether to use the test key or production key
 * @returns {Promise<CryptoKey?>}
 */
export async function hmacclientkey(env, ctx1, test = false) {
  const seed = test ? env.KDF_SECRET_CLIENT_TEST : env.KDF_SECRET_CLIENT;
  if (!seed) {
    log.e("key: KDF_SECRET_CLIENT missing; test?", test);
    return null;
  }
  const ikm = bin.hex2buf(seed);
  return importhmacclientkey(ikm, ctx1, clienthmackeyctx2);
}

/**
 * @param {ArrayBufferLike} sk - secret keying material
 * @param {BufferSource} ctx1 - key context 1
 * @param {BufferSource} ctx2 - key context 2
 * @returns {Promise<CryptoKey?>}
 */
async function importhmacclientkey(sk, ctx1, ctx2) {
  if (bin.emptyBuf(sk) || bin.emptyBuf(ctx1) || bin.emptyBuf(ctx2)) {
    log.d("keygen: hmac: invalid seed/ctx");
    return null;
  }

  try {
    if (sk.length < hkdfalgkeysz) {
      log.e("keygen: hmac: seed too short", sk.length, hkdfalgkeysz);
      return null;
    }

    const sk256 = sk.slice(0, hkdfalgkeysz);
    // info must always of a fixed size for ALL KDF calls
    const info512 = await sha512(bin.cat(ctx1, ctx2));
    // exportable: crypto.subtle.exportKey("raw", key);
    return hkdfhmac(sk256, info512, clienthmackeysalt);
  } catch (ignore) {
    log.d("keygen: hmac: err", ignore);
  }

  return null;
}
