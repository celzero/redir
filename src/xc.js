// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import { workersEnv } from "./d.js";
import { aesivsz, hkdfaes, hkdfalgkeysz, sha512 } from "./hmac.js";
import * as glog from "./log.js";
import { crand, encryptAesGcm } from "./webcrypto.js";

const ctx = bin.str2byte("encryptcrossservice");
const log = new glog.Log("xc");

/**
 * bad request
 * @param {string} u - status message
 * @returns {Response} - Response with status 400
 */
function r400t(u) {
  return new Response(u, { status: 400 });
}

/**
 * internal server error
 * @param {string} u - status message
 * @returns {Response} - Response with status 500
 */
function r500t(u) {
  return new Response(u, { status: 500 });
}

/**
 *
 * @param {any} env - Worker environment
 * @param {Request} req - Request object
 * @returns {Promise<Response>} - Response with encrypted cert
 */
export async function certfile(env, req) {
  if (env == null || req == null || req.method != "GET") {
    return r400t("args missing");
  }
  const part0 = env.FLY_TLS_CERTKEY0;
  const part1 = env.FLY_TLS_CERTKEY1;
  if (bin.emptyString(part0) || bin.emptyString(part1)) {
    return r400t("cert parts not found");
  }
  try {
    const crt = part0 + part1;
    const enccrthex = await encryptText(env, req, crt);
    if (bin.emptyString(enccrthex)) {
      return r500t("could not encrypt cert");
    }
    return new Response(enccrthex, {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (err) {
    log.e("certfile: failed to encrypt cert", err);
  }
  return r500t("server error");
}

/**
 * @param {any} env - Worker environment
 * @param {Request} req - Cross service request object
 * @param {string} plaintext - The plaintext to encrypt (utf8)
 * @returns {Promise<string|null>} - Encrypted hex string with iv (96 bits) prepended and tag appended; or null on failure
 */
async function encryptText(env, req, plaintext) {
  const now = new Date();
  const u = new URL(req.url);

  // 1 Aug 2025 => "5/7/2025" => Friday, 7th month (0-indexed), 2025
  const aadstr =
    now.getUTCDay() +
    "/" +
    now.getUTCMonth() +
    "/" +
    now.getUTCFullYear() +
    "/" +
    u.hostname +
    "/" +
    u.pathname +
    "/" +
    req.method;

  const iv = crand(aesivsz);
  const enckey = await key(env);
  if (!enckey || !iv) {
    log.e("encrypt: key/iv missing");
    return null;
  }

  try {
    const pt = bin.str2byte(plaintext);
    const aad = bin.str2byte(aadstr);
    const taggedcipher = await encryptAesGcm(enckey, iv, pt, aad);
    const ivciphertaghex = bin.buf2hex(iv) + bin.buf2hex(taggedcipher);

    log.d(
      "decrypt: ivciphertag",
      ivciphertaghex.length,
      "iv",
      iv.length,
      "ciphertag",
      taggedcipher.length,
      "aad",
      aadstr,
      aad.length
    );
    return ivciphertaghex;
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
async function key(env) {
  if (bin.emptyBuf(ctx)) {
    log.e("key: ctx missing");
    return null;
  }

  env = !env ? workersEnv() : env;
  const seed = env.KDF_XSVC;
  if (!seed) {
    log.e("key: KDF_XSVC missing");
    return null;
  }

  const sk = bin.hex2buf(seed);
  if (bin.emptyBuf(sk)) {
    log.e("key: kdf seed conv empty");
    return null;
  }

  if (sk.length < hkdfalgkeysz) {
    log.e("keygen: seed too short", sk.length, hkdfalgkeysz);
    return null;
  }

  try {
    const sk256 = sk.slice(0, hkdfalgkeysz);
    // info must always of a fixed size for ALL KDF calls
    const info512 = await sha512(ctx);
    // key fingerprint
    // const f = await sha512(bin.cat(sk, info512));
    // exportable: crypto.subtle.exportKey("raw", key);
    // log.d("generating key... fingerprint:", bin.buf2hex(f));
    return hkdfaes(sk256, info512);
  } catch (ignore) {
    log.d("keygen: err", ignore);
  }
  return null;
}
