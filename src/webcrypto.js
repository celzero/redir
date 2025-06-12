/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { byt } from "./buf.js";

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
