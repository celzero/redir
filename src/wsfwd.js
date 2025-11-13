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

  if (!allowlisted(u)) {
    log.w("forwardToWs: not allowlisted", u.pathname);
    return r421t("lost");
  }

  const [cid, token, enctoken, needsAuth, mustEncrypt] =
    await bearerAndCidForWs(env, r);
  if (needsAuth) {
    if (emptyString(token)) return r401("needs cid or auth");
    if (mustEncrypt && emptyString(cid)) return r401("needs cid or auth");
  }

  const [typ, sensitive, test] = reqType(u);
  const cloned = new Request(r);

  withWsHostname(u, typ);
  tryAddAuthHeader(cloned, token);
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
    const j = await r.json();
    const wsuser = new WSUser(j.data);
    const hasSensitiveData = !emptyString(wsuser.sessionAuthHash);
    const newSensitiveData =
      hasSensitiveData && wsuser.sessionAuthHash != token;

    log.d(
      `forwardToWs: enc/sen/diff? ${mustEncrypt} ${hasSensitiveData} ${newSensitiveData}`
    );
    if (mustEncrypt && hasSensitiveData && newSensitiveData) {
      const newenctokenhex = await encryptText(
        env,
        cid,
        wsuser.sessionAuthHash
      );
      if (emptyString(newenctokenhex)) {
        throw new Error("encrypted new auth is empty");
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
  const validcid = cid != null && cid.length > 0 && /^[0-9a-f]{64}$/.test(cid);
  if (!validcid) cid = null; // ensure cid is null if invalid

  if (!needsAuth) {
    return [null, null, null, /*needsAuth*/ false, /*mustEncrypt*/ false];
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
    log.d("bearerAndCidForWs: no cid", cid, "or token", emptyString(enctoken));
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
