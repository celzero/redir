/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { buf2b64url, str2byte } from "./buf.js";
import { rsaSsaSign } from "./webcrypto";

// from: gist.github.com/markelliot/6627143be1fc8209c9662c504d0ff205?permalink_comment_id=4177336#gistcomment-4177336

/**
 * @param {string} content - The content to sign, typically a JWT header and claimset
 * @param {string} signingKey - PEM formatted private key
 * @returns {Promise<string>} - Returns the base64url encoded signature
 */
async function sign(content, signingKey) {
  const signed = await rsaSsaSign(content, signingKey);
  return buf2b64url(signed);
}

/**
 * @param {string} user - service account email
 * @param {string} key - service account private key
 * @param {string[]} scopes - OAuth scopes; ['https://www.googleapis.com/auth/cloud-platform']
 * @returns {Promise<string|null>} - Returns the Google OAuth access token or null on failure
 */
export async function getGoogleAuthToken(user, key, scopes) {
  const jwtHeader = obj2b64url({ alg: "RS256", typ: "JWT" });
  try {
    const assertiontime = Math.round(Date.now() / 1000);
    const expirytime = assertiontime + 3600;
    const scope = scopes.join(" ");
    const claimset = obj2b64url({
      iss: user,
      scope, // if scope is an array; do scopes.join(' ')
      aud: "https://oauth2.googleapis.com/token",
      exp: expirytime,
      iat: assertiontime,
    });

    const jwtUnsigned = `${jwtHeader}.${claimset}`;
    const jwtSigned = await sign(jwtUnsigned, key);
    const jwt = `${jwtUnsigned}.${jwtSigned}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

    logd(`gauth: ${jwt} ${key.length}`);

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
        Host: "oauth2.googleapis.com",
      },
      body,
    });
    // {
    //   "access_token": "ya29.a0ARrdaM...",
    //   "expires_in": 3599,
    //   "token_type": "Bearer"
    // }
    const { access_token } = await r.json();
    return access_token;
  } catch (err) {
    loge(err.message, err);
    logdir(err);
  }
  return null;
}

function obj2b64url(object) {
  return buf2b64url(str2byte(JSON.stringify(object)));
}

function logd(...args) {
  console.debug("gauth:", ...args);
}

function loge(...args) {
  console.error("gauth:", ...args);
}

function logdir(obj) {
  console.dir(obj);
}
