// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import { emptyString } from "./buf.js";
import { decryptText, encryptText } from "./enc.js";
import * as glog from "./log.js";
import { mincidlength } from "./reg.js";
import {
  consumejson,
  didTokenHeader,
  r400err,
  r401err,
  r421err,
} from "./req.js";
import { WSUser } from "./wsent.js";

const log = new glog.Log("wsfwd");

const wsApiTest = "api-staging.windscribe.com";
const wsAssetsTest = "assets-staging.windscribe.com";
const wsApiProd = "api.windscribe.com";
const wsAssetsProd = "assets.windscribe.com";

const wswginitpath = "/wgconfigs/init";
const wswgconnectpath = "/wgconfigs/connect";
const wssessionpath = "/session";
const wsportpath = "/portmap";
const wslocpath = "/serverlist/mob-v2/";

const wsprodquery = "ws";
const wstestquery = "wstest";
const wsassetsquery = "wsassets";
const wsassetstestquery1 = "wsassetstest";
const wsassetstestquery2 = "wstestassets";

/**
 * @param {any} env - Worker environment
 * @param {Request} r
 * @returns {Promise<Response>}
 */
export async function forwardToWs(env, r) {
  const u = new URL(r.url);

  if (!allowlisted(u)) {
    log.w("forwardToWs: not allowlisted", u.pathname);
    return r421err("wsf: lost");
  }

  const [cid, token, enctoken, needsAuth, mustEncrypt] =
    await bearerAndCidForWs(env, r);
  if (needsAuth) {
    if (emptyString(token)) return r401err("wsf: needs cid or auth");
    if (mustEncrypt && emptyString(cid))
      return r401err("wsf: needs cid or auth");
  }

  const [typ, sensitive, test] = reqType(u);
  const cloned = new Request(r);

  withWsHostname(u, typ);
  tryAddAuthHeader(cloned, token);
  removeHeader(cloned, didTokenHeader);
  removeCmds(u);

  if (test) {
    log.d(u.href, typ, token, enctoken, "s/e:", sensitive, mustEncrypt);
  } else {
    log.d(u.href, typ, enctoken, "s/e:", sensitive, mustEncrypt);
  }

  if (!sensitive) {
    // pipe non-sensitive as-is
    return fetch(u, cloned);
  }

  try {
    const r = await fetch(u, cloned);
    if (!r.ok) {
      log.w(`get session: ${r.status}`);
      return r;
    }
    // j = { data: { ... }, metadata: { ... } }
    const j = await consumejson(r);
    if (j == null || j.data == null) {
      throw new Error(`wsf: empty/unexpected response (${r.status})`);
    }
    const wsuser = new WSUser(j.data);
    const hasSensitiveData = !emptyString(wsuser.sessionAuthHash);
    const newSensitiveData =
      hasSensitiveData && wsuser.sessionAuthHash != token;

    log.d(
      `forwardToWs: enc/sen/diff? ${mustEncrypt} ${hasSensitiveData} ${newSensitiveData}`,
    );
    if (mustEncrypt && hasSensitiveData && newSensitiveData) {
      const newenctokenhex = await encryptText(
        env,
        cid,
        wsuser.sessionAuthHash,
      );
      if (emptyString(newenctokenhex)) {
        throw new Error("wsf: encrypted new auth is empty");
      }
      wsuser.sessionAuthHash = newenctokenhex;
    } else {
      wsuser.sessionAuthHash = enctoken; // retain original token
    }

    return new Response(
      JSON.stringify({
        data: wsuser.jsonable(),
        metadata: j.metadata || {},
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    log.e("forwardToWs: failed", err);
    return r400err(`wsf: remote: ${err.message}`);
  }
}

/**
 * @param {URL} u
 * @param {string} typ - request type
 * @returns {URL} - modified URL with the correct hostname
 */
function withWsHostname(u, typ) {
  if (typ == wsprodquery) u.hostname = wsApiProd;
  if (typ == wstestquery) u.hostname = wsApiTest;
  if (typ == wsassetsquery) u.hostname = wsAssetsProd;
  if (typ == wsassetstestquery1) u.hostname = wsAssetsTest;
  if (typ == wsassetstestquery2) u.hostname = wsAssetsTest;
  return u;
}

/**
 * @param {Request} req
 * @param {string} token
 */
function tryAddAuthHeader(req, token) {
  if (emptyString(token)) return;
  req.headers.set("Authorization", `Bearer ${token}`);
}

/**
 * @param {Request} req
 * @param {string} hdr - header name to remove
 */
function removeHeader(req, hdr) {
  req.headers.delete(hdr);
}

/**
 * @param {URL} u
 */
function removeCmds(u) {
  if (u == null || u.searchParams == null) return;
  u.searchParams.delete("rpn");
}

/**
 * @param {URL} url
 * @returns {boolean} - true if the request must be sent to Windscribe
 */
function forwardToWsWithAuth(url) {
  const q = url.searchParams;
  const w = q.get("rpn");
  return (
    w != null && w.length > 0 && w.startsWith("ws") && w.indexOf("assets") < 0
  );
}

/**
 * @param {any} env - Worker environment
 * @param {Request} req - The request object
 * @returns {Promise<[string|null, string|null, string|null, boolean, boolean]>} - [cid, token, enctoken, needsAuth, mustDecrypt]
 *          or [null, null, encToken|null, needsAuth, mustDecrypt] if not available
 */
async function bearerAndCidForWs(env, req) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const authHeader = req.headers.get("Authorization");
  const authVals = authHeader ? authHeader.split(" ") : [];
  const needsAuth = forwardToWsWithAuth(url);
  let cid = q.get("cid"); // may be null
  const validcid =
    cid != null && cid.length >= mincidlength && /^[a-fA-F0-9]+$/.test(cid);
  if (!validcid) cid = null; // ensure cid is null if invalid

  if (!needsAuth) {
    return [cid, null, null, /*needsAuth*/ false, /*mustEncrypt*/ false];
  }

  if (authVals.length < 2 || authVals[0] !== "Bearer") {
    log.d("bearerAndCidForWs: no auth header", authHeader, "or vals", authVals);
    return [cid, null, null, /*needsAuth*/ true, /*mustEncrypt*/ false];
  }

  /** @type {string} - of type "id:typ:epoch:sig1:sig2" */
  const enctoken = authVals[1];
  const toks = enctoken.split(":");
  if (toks.length > 4) {
    log.d("bearerAndCidForWs: already decrypted", toks[0]);
    // already decrypted (or was left unencrypted)
    return [cid, null, null, /*needsAuth*/ true, /*mustEncrypt*/ false];
  }

  if (!validcid || emptyString(enctoken)) {
    log.d(
      "bearerAndCidForWs: no cid",
      cid,
      "or token empty?",
      emptyString(enctoken),
    );
    return [cid, null, null, /*needsAuth*/ true, /*mustEncrypt*/ false]; // no cid or token
  }

  const dectok = await decryptText(env, cid, enctoken);
  return [cid, dectok, enctoken, needsAuth, /*mustEncrypt*/ true];
}

/**
 * @param {URL} u
 * @returns {[string, boolean, boolean]} - request type, sensitive flag, test flag
 */
function reqType(u) {
  const s = u.searchParams;
  const p = u.pathname;
  if (s.has("rpn")) {
    const typ = s.get("rpn");
    // wsassetstest or wstestassets are both test environments
    const test = !emptyString(typ) && typ.indexOf("test") >= 0;
    // /Session contains SessionAuthHash in its output
    // which must be re-encrypted
    const sensitive = p.indexOf("/Session") >= 0;
    return [typ, sensitive, test];
  }
  return ["", false, false];
}

/**
 * @param {URL} u - URL to check
 * @returns {boolean} - true if the path is allowlisted for WebSocket forwarding
 */
function allowlisted(u) {
  if (u == null) return false; // no url

  let p = u.pathname;
  if (emptyString(p)) return false; // no pathname

  p = p.toLowerCase(); // normalize to lowercase
  if (p.startsWith(wswginitpath)) return true;
  if (p.startsWith(wswgconnectpath)) return true;
  if (p.startsWith(wssessionpath)) return true;
  if (p.startsWith(wsportpath)) return true;
  if (p.startsWith(wslocpath)) return true;

  return false;
}
