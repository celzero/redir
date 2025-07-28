// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import { emptyString } from "./buf.js";
import { decryptText, encryptText } from "./enc.js";
import * as glog from "./log.js";
import { WSUser } from "./wsent.js";

const log = new glog.Log("wsfwd");

const wsApiTest = "api-staging.windscribe.com";
const wsAssetsTest = "assets-staging.windscribe.com";
const wsApiProd = "api.windscribe.com";
const wsAssetsProd = "assets.windscribe.com";

/**
 * unauthorized
 * @param {string} u
 */
function r401(u) {
  return new Response(u, { status: 401 });
}

/**
 * bad request
 * @param {string} u
 */
function r400t(u) {
  return new Response(u, { status: 400 });
}

/**
 * misdirected
 * @param {string} u
 */
function r421t(u) {
  return new Response(u, { status: 421 });
}

/**
 * @param {any} env - Worker environment
 * @param {Request} r
 * @returns {Promise<Response>}
 */
export async function forwardToWs(env, r) {
  const u = new URL(r.url);

  const needsAuth = forwardToWsWithAuth(u);
  const [cid, token] = await bearerAndCidForWs(env, r);
  if (needsAuth && (emptyString(token) || cid == null)) {
    return r401("needs auth");
  }
  const [typ, sensitive] = reqType(u);
  const cloned = new Request(r);

  withWsHostname(u, typ);
  tryAddAuthHeader(cloned, token);
  removeCmds(u);

  log.d(u.pathname, u.hostname, u.search, typ);

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
    const j = await r.json();
    const wsuser = new WSUser(j.data);
    if (wsuser.sessionAuthHash) {
      const enctoken = await encryptText(env, cid, wsuser.sessionAuthHash);
      wsuser.sessionAuthHash = enctoken;
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
      }
    );
  } catch (err) {
    log.e("forwardToWs: failed", err);
    return r400t(`remote: ${err.message}`);
  }
}

/**
 * @param {URL} u
 * @param {string} typ - request type
 * @returns {URL} - modified URL with the correct hostname
 */
function withWsHostname(u, typ) {
  if (typ == "ws") u.hostname = wsApiProd;
  if (typ == "wstest") u.hostname = wsApiTest;
  if (typ == "wsassets") u.hostname = wsAssetsProd;
  if (typ == "wsassetstest") u.hostname = wsAssetsTest;
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
 * @returns {Promise<[string|null, string|null]>} - [cid, token] or [null, null] if not available
 */
async function bearerAndCidForWs(env, req) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const authHeader = req.headers.get("Authorization");
  const authVals = authHeader ? authHeader.split(" ") : [];
  if (authVals.length < 2 || authVals[0] !== "Bearer") {
    return [null, null]; // no auth
  }
  const enctoken = authVals[1];
  const cid = q.get("cid");
  if (emptyString(cid) || emptyString(enctoken)) {
    return [null, null]; // no cid
  }
  return [cid, await decryptText(env, cid, enctoken)];
}

/**
 * @param {URL} u
 * @returns {[string, boolean]} - request type and sensitive flag
 */
function reqType(u) {
  const s = u.searchParams;
  const p = u.pathname;
  if (s.has("rpn")) {
    const typ = s.get("rpn");
    // /Session contains SessionAuthHash in its output
    // which must be re-encrypted
    const sensitive = p.indexOf("/Session") >= 0;
    return [typ, sensitive];
  }
  return ["", false];
}
