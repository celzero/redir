// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import { testmode } from "./d.js";
import * as dbenc from "./dbenc.js";
import { hmackey3, hmacsign } from "./hmac.js";
import * as glog from "./log.js";
import {
  getOnetimeProductV2,
  getSubscription,
  googlePlayAcknowledgePurchase,
} from "./playorder.js";
import {
  authorization,
  cid,
  consumejson,
  contentlen,
  force as forceOf,
  isTest,
  r200j,
  r400err,
  r401err,
  r403err,
  r412play,
  sku as skuOf,
} from "./req.js";
import * as dbx from "./sql/dbx.js";
import {
  WSUser,
  creds,
  resourcesession,
  resourceuser,
  wstokaad,
} from "./wsent.js";

const log = new glog.Log("admin");

const adminTokenHeader = "x-rethink-app-admin-token";
const adminTsHeader = "x-rethink-app-admin-ts";
const adminTokenWindowMs = 300 * 1000; // +/- 5mins

const wsSessionPath = resourcesession;
const wsRawPaymentsPath = "WhitelabelPayments/rawpayments";
const wsStatsPath = "WhitelabelPayments/stats/";
const wsUsersPath = resourceuser;

const wsresource = "ws";
const wsuser = "u";
const wsentitlement = "e";
const wsplaytoken = "pt";
const wsplayack = "playack";
const rawpaymentsquery = "pay";
const paymentstatsdate = "date";
const subsresource = "subs";

const localQueryParams = new Set(["ws", "cid", "did", "test"]);

/**
 * Builds a Windscribe target URL, copying query params from req except local
 * ones (ws, cid, did, test) and any extraLocalParams.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @param {string} path - The WS API path (e.g., "/Session", "/Users")
 * @param {string[]} [extraLocalParams] - Additional query params to strip
 * @returns {URL} - The target URL to forward to
 */
function buildUrl(env, req, path, extraLocalParams = []) {
  const u = new URL(wsBaseUrl(env) + path);
  const requrl = new URL(req.url);
  const skip = new Set([...localQueryParams, ...extraLocalParams]);
  for (const [k, v] of requrl.searchParams.entries()) {
    if (!skip.has(k)) {
      u.searchParams.set(k, v);
    }
  }
  return u;
}

/**
 * Copies headers from req, filtering out local x-rethink prefixed ones.
 * @param {Request} req - The incoming request
 * @returns {Headers} - Filtered headers
 */
function buildHeaders(req) {
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (!k.toLowerCase().startsWith("x-rethink")) {
      headers.set(k, v);
    }
  }
  return headers;
}

/**
 * Extracts an unencrypted bearer token from the Authorization header.
 * Unencrypted tokens contain ":" separators (id:type:epoch:sig1:sig2),
 * unlike encrypted tokens which are plain hex strings.
 * Returns null if no usable token.
 * @param {Request} req - The incoming request
 * @returns {string|null} - unencrypted bearer token or null
 */
function unencryptedSessionToken(req) {
  const auth = authorization(req);
  if (bin.emptyString(auth)) return null;
  const parts = auth.split(" ");
  if (parts.length < 2 || parts[0] !== "Bearer") return null;

  // plain hex tokens are encrypted & do not contain ":"
  const tok = parts[1];
  if (!tok.includes(":")) return null;

  // unencrypted tokens have 4x ":" (id:type:epoch:sig1:sig2),
  const tokparts = tok.split(":");
  if (tokparts.length < 5) return null;
  return tok;
}

/**
 * Authenticates an admin request using HMAC over unix epoch millis.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<boolean>} - true if authenticated; the caller should respond
 *   with 401 or 403 if false is returned (handled by calling handleAdmin).
 */
async function authenticate(env, req) {
  const tokenHex = req.headers.get(adminTokenHeader);
  const tsStr = req.headers.get(adminTsHeader);

  if (bin.emptyString(tokenHex) || bin.emptyString(tsStr)) {
    log.d("auth: missing token or ts header");
    return false;
  }

  // parse unix epoch millis
  const tsMillis = parseInt(tsStr, 10);
  if (isNaN(tsMillis) || tsMillis <= 0) {
    log.w("auth: invalid ts", tsStr);
    return false;
  }

  // check time window: +/- 100s from now
  const nowMs = Date.now();
  const diffMs = Math.abs(nowMs - tsMillis);
  if (diffMs > adminTokenWindowMs) {
    log.w("auth: ts out of window", tsMillis, "now:", nowMs, "diff:", diffMs);
    return false; // caller should return 403
  }

  // derive HMAC key from ADMIN_SECRET (64-char hex string)
  const adminSecret = env.ADMIN_SECRET;
  if (bin.emptyString(adminSecret)) {
    log.e("auth: ADMIN_SECRET missing");
    return false;
  }

  try {
    const sk = bin.hex2buf(adminSecret); // 32 bytes
    const key = await hmackey3(sk);
    // message is unixepochmillis as string'd number converted to utf8 bytes
    const msg = bin.str2byte(tsStr);
    const sig = await hmacsign(key, msg);
    const expectedHex = bin.buf2hex(new Uint8Array(sig));

    if (!bin.safeEq(bin.str2byte(expectedHex), bin.str2byte(tokenHex))) {
      log.w(
        "auth: sig mismatch",
        tokenHex.slice(0, 8),
        "vs",
        expectedHex.slice(0, 8),
      );
      return false;
    }
    return true;
  } catch (err) {
    log.e("auth: hmac err", err);
  }

  return false;
}

/**
 * @param {any} env - Worker environment
 * @returns {string} - the WS API base URL for the current test/prod context
 */
function wsBaseUrl(env) {
  if (testmode("any")) {
    return env.WS_URL_TEST;
  }
  return env.WS_URL;
}

/**
 * @param {any} env - Worker environment
 * @returns {[string, string]} - [wlId, wlToken] for WS API auth
 */
function wsWlHeaders(env) {
  const test = testmode("any");
  const id = test ? env.WS_WL_ID_TEST : env.WS_WL_ID;
  const token = test ? env.WS_WL_TOKEN_TEST : env.WS_WL_TOKEN;
  return [id, token];
}

/**
 * GET /a/ws?cid=<hex>
 * Retrieves the session token from the ws table for the given cid,
 * decrypts it, calls Windscribe /Session, and returns the raw JSON output.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminSession(env, req) {
  if (req.method !== "GET") {
    return r400err("only GET allowed");
  }
  const c = cid(req);
  let sessiontoken = unencryptedSessionToken(req);
  let cred = null;

  if (sessiontoken == null) {
    if (bin.emptyString(c)) return r400err("sess: missing cid");
    cred = await creds(env, c, "adminsess", "any");
    if (cred == null) return r400err("sess: no ws creds for cid");
    sessiontoken = cred.sessiontoken;
    if (bin.emptyString(sessiontoken)) {
      return r400err("sess: missing sessiontoken for cid");
    }
  } else {
    log.d("sess: using provided bearer token");
  }

  const wsUrl = buildUrl(env, req, wsSessionPath);
  const headers = buildHeaders(req);
  headers.set("Authorization", `Bearer ${sessiontoken}`);

  log.d("sess: forwarding...", wsUrl.href);

  try {
    const r = await fetch(wsUrl, { method: "GET", headers });

    log.d("sess: response...", wsUrl.href, r.status, contentlen(r));

    const j = await consumejson(r);
    if (j == null) {
      return r400err(`sess: empty response (${r.status})`);
    }
    j.session_auth_hash = sessiontoken;
    if (cred != null) {
      j.test = cred.test;
      j.exp = cred.expiry;
    }
    return r200j(j);
  } catch (err) {
    log.e("sess: fetch err", err);
    return r400err(`sess: ${err.message}`);
  }
}

/**
 * GET /a/ws?pay
 * Retrieves raw payments info from Windscribe /WhitelabelPayments/rawpayments.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminRawPayments(env, req) {
  if (req.method !== "GET") {
    return r400err("only GET allowed");
  }
  const wsUrl = buildUrl(env, req, wsRawPaymentsPath);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("pay: forwarding...", wsUrl.href);

  try {
    const r = await fetch(wsUrl, { method: "GET", headers });

    log.d("pay: response...", wsUrl.href, r.status, contentlen(r));

    const j = await consumejson(r);
    if (j == null) {
      return r400err(`pay: empty response from WS (${r.status})`);
    }
    return r200j(j);
  } catch (err) {
    log.e("pay: fetch err", err);
    return r400err(`pay: ${err.message}`);
  }
}

/**
 * GET /a/ws?pay&date=yyyy-mm
 * Retrieves monthly stats from Windscribe /WhitelabelPayments/stats/{date}.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminMonthlyStats(env, req) {
  if (req.method !== "GET") {
    return r400err("only GET allowed");
  }
  const u = new URL(req.url);
  const date = u.searchParams.get("date");

  if (bin.emptyString(date)) {
    return r400err("stats: missing date (yyyy-mm)");
  }

  // Basic validation: yyyy-mm format
  if (!/^\d{4}-\d{2}$/.test(date)) {
    return r400err("stats: invalid date format; expected yyyy-mm");
  }

  // Validate month is 01-12
  const month = parseInt(date.split("-")[1], 10);
  if (month < 1 || month > 12) {
    return r400err("stats: invalid month; expected 01-12");
  }

  const wsUrl = buildUrl(env, req, wsStatsPath + date, ["date"]);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("stats: forwarding...", wsUrl.href);

  try {
    const r = await fetch(wsUrl, { method: "GET", headers });

    log.d("stats: response...", wsUrl.href, contentlen(r));

    const j = await consumejson(r);
    if (j == null) {
      return r400err(`stats: empty response from WS (${r.status})`);
    }
    return r200j(j);
  } catch (err) {
    log.e("stats: fetch err", err);
    return r400err(`stats: ${err.message}`);
  }
}

/**
 * PUT /a/ws/u
 * Proxies an update to Windscribe /Users, passing through query params,
 * headers, and body while stripping local ones.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminUpdateUser(env, req) {
  if (req.method !== "PUT") {
    return r400err("only PUT allowed");
  }

  const c = cid(req);
  let sessiontoken = unencryptedSessionToken(req);

  if (sessiontoken == null) {
    if (bin.emptyString(c)) return r400err("update: missing cid");
    const cred = await creds(env, c, "adminupdate", "any");
    if (cred == null) return r400err("update: no ws creds for cid");
    sessiontoken = cred.sessiontoken;
    if (bin.emptyString(sessiontoken)) {
      return r400err("update: missing sessiontoken for cid");
    }
  } else {
    log.d("update: using provided bearer token");
  }

  const wsUrl = buildUrl(env, req, wsUsersPath);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("Authorization", `Bearer ${sessiontoken}`);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("update: forwarding...", wsUrl.href);

  try {
    const r = await fetch(wsUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    });

    log.d("update: response...", wsUrl.href, r.status, contentlen(r));

    return new Response(r.body, r);
  } catch (err) {
    log.e("update: fetch err", err);
    return r400err(`update: ${err.message}`);
  }
}

/**
 * PUT /a/ws/e
 * Updates the encrypted session token stored in the ws table for a given
 * cid.  The caller sends an unencrypted session token (id:type:epoch:sig1:sig2)
 * via the Authorization header.  The function calls Windscribe /Session to
 * verify the token, checks that the returned user_id matches the one already
 * stored in the database, and then encrypts and persists the new token.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminUpdateWsEntitlement(env, req) {
  if (req.method !== "PUT") {
    return r400err("only PUT allowed");
  }

  const c = cid(req);
  if (bin.emptyString(c)) return r400err("ent: missing cid");

  // Must provide an unencrypted session token (contains ":")
  const sessiontoken = unencryptedSessionToken(req);
  if (bin.emptyString(sessiontoken)) {
    return r400err("ent: missing or invalid bearer token");
  }

  // Look up existing creds from DB to get the stored userid
  const db = dbx.db(env);
  const out = await dbx.wsCreds(db, c);
  if (!out.results || out.results.length <= 0) {
    return r400err("ent: no ws creds for cid");
  }

  const row = out.results[0];
  const uid = row.userid || null;
  if (bin.emptyString(uid)) {
    return r400err("ent: missing userid for cid");
  }

  // Call Windscribe /Session to verify the token and get the WS user
  const wsUrl = buildUrl(env, req, wsSessionPath);
  const headers = buildHeaders(req);
  headers.set("Authorization", `Bearer ${sessiontoken}`);

  log.d("ent: forwarding /Session...", wsUrl.href);

  let wsuser;
  try {
    const r = await fetch(wsUrl, { method: "GET", headers });
    if (!r.ok) {
      return r400err(`ent: err /Session res (${r.status})`);
    }
    const j = await consumejson(r);
    if (j == null || j.data == null) {
      return r400err(`ent: err /Session empty response (${r.status})`);
    }
    wsuser = new WSUser(j.data);
  } catch (err) {
    log.e("ent: /Session fetch err", err);
    return r400err(`ent: /Session err: ${err.message}`);
  }

  if (bin.emptyString(wsuser.userId)) {
    return r400err("ent: missing userid in /Session response");
  }

  // Verify the user_id matches the one stored in the database
  if (wsuser.userId !== uid) {
    log.e(`ent: userid mismatch: db=${uid} vs ws=${wsuser.userId}`);
    return r400err("ent: userid mismatch");
  }

  // Encrypt the session token for storage
  const ctime = dbx.sqliteutc(row.ctime);
  let aad = null;
  if (
    !isNaN(ctime.getTime()) &&
    ctime.getTime() > dbenc.aadRequirementStartTime
  ) {
    aad = wstokaad;
  }

  const newEnctok = await dbenc.encryptText(env, c, uid, aad, sessiontoken);
  if (bin.emptyString(newEnctok)) {
    return r400err("ent: failed to encrypt sessiontoken");
  }

  // Update the ws table: upsert encrypted token
  const upsertOut = await dbx.upsertCreds(db, c, uid, newEnctok);
  if (!upsertOut || !upsertOut.success) {
    return r400err("ent: failed to update ws table");
  }

  log.d(
    `ent: updated ws creds for cid=${c}, uid=${uid}, tok=${newEnctok.slice(0, 8)}...`,
  );
  return r200j({ success: 1, cid: c });
}

/**
 * GET /a/ws/pt?cid=<hex>
 * Fetches active play purchase tokens and their current state from Google.
 * For each active purchase in the playorders table, parses the meta column
 * to determine whether it is a subscription or onetime purchase, then
 * calls the corresponding Google API to get the latest purchase state.
 * Returns both the stored DB rows and the Google-fetched state.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminPlayPurchaseState(env, req) {
  if (req.method !== "GET") {
    return r400err("only GET allowed");
  }
  const c = cid(req);
  if (bin.emptyString(c)) return r400err("pt: missing cid");

  const db = dbx.db(env);
  const out = await dbx.playActiveByCid(db, c);
  if (out == null || !out.success) {
    return r400err("pt: db error");
  }
  if (out.results == null || out.results.length <= 0) {
    return r200j({ cid: c, purchases: [] });
  }

  const purchases = [];
  for (const row of out.results) {
    const entry = {
      purchasetoken: row.purchasetoken || null,
      linkedtoken: row.linkedtoken || null,
      ctime: row.ctime || null,
      mtime: row.mtime || null,
      metadb: null,
      metanew: null,
      err: null,
    };

    // parse stored meta
    try {
      entry.metadb = row.meta != null ? JSON.parse(row.meta) : null;
    } catch (_) {
      entry.metadb = row.meta;
    }

    // fetch latest state from Google if meta is available
    const purchaseToken = row.purchasetoken;
    if (bin.emptyString(purchaseToken)) {
      entry.err = "missing purchase token";
      purchases.push(entry);
      continue;
    }

    try {
      const kind =
        entry.metadb && typeof entry.metadb === "object"
          ? entry.metadb.kind || "<empty kind>"
          : "<missing kind>";

      if (kind === "androidpublisher#subscriptionPurchaseV2") {
        const sub = await getSubscription(env, purchaseToken);
        entry.metanew = sub;
      } else if (kind === "androidpublisher#productPurchaseV2") {
        const prod = await getOnetimeProductV2(env, purchaseToken, null);
        entry.metanew = prod;
      } else {
        entry.err = `unknown kind: ${kind}`;
      }
    } catch (err) {
      log.e(`pt: err fetching google state for ${c}: ${err.message}`);
      entry.err = err.message;
    }

    purchases.push(entry);
  }

  return r200j({ cid: c, purchases });
}

/**
 * POST /a/ws/playack?cid=<hex>[&sku=<productId>][&force=<any>]
 *
 * Acknowledges the latest active purchase for the given cid. Looks up the most
 * recent active playorder row (via playActiveByCid, sorted by mtime desc),
 * then delegates to googlePlayAcknowledgePurchase.
 *
 * If no active purchase is found, returns a 404.
 * If more than one active purchase is found and `force` is not set, returns a
 * 412 Precondition Failed.  If `force` is set, logs a warning and proceeds with
 * the most recently modified row.
 *
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminPlayAcknowledgePurchase(env, req) {
  if (req.method !== "POST") {
    return r400err("only POST allowed");
  }

  const c = cid(req);
  if (bin.emptyString(c)) return r400err("playack: missing cid");

  const sku = skuOf(req);
  const db = dbx.db(env);
  const out = await dbx.playActiveByCid(db, c, 2);
  if (out == null || !out.success) {
    return r400err("playack: db error");
  }
  if (out.results == null || out.results.length <= 0) {
    return r400err("playack: no active purchase found");
  }

  const f = forceOf(req);
  if (out.results.length > 1 && bin.emptyString(f)) {
    return r412play({
      error: `playack: ${out.results.length} active purchases for cid=${c}; force required`,
    });
  }
  if (out.results.length > 1) {
    log.w(
      `playack: ${out.results.length} active purchases for cid=${c}; proceeding with most recent (force)`,
    );
  }

  // Use the most-recently-modified purchase (sorted by mtime DESC)
  const row = out.results[0];
  const purchaseToken = row.purchasetoken;
  if (bin.emptyString(purchaseToken)) {
    return r400err("playack: active purchase has no purchase token");
  }

  // set query params "purchaseToken", "cid", "sku", "test", "force".
  const u = new URL(req.url);
  u.searchParams.set("purchaseToken", purchaseToken);
  u.searchParams.set("cid", c);
  if (!bin.emptyString(sku)) {
    u.searchParams.set("sku", sku);
  }
  // Forward test mode from the original request.
  if (isTest(req)) {
    u.searchParams.set("test", "true");
  }
  // Forward force param from the original request.
  if (!bin.emptyString(f)) {
    u.searchParams.set("force", f);
  }

  const freq = new Request(u, { method: "POST" });

  log.d(`playack: acking purchase ${c} / tok: ${purchaseToken} / sku: ${sku}`);

  // Delegate to the existing ack function and pass through its response.
  return googlePlayAcknowledgePurchase(env, freq);
}

/**
 * GET /a/subs?d=<days>
 * Returns all active subscriptions (subscriptions and onetime purchases)
 * whose ctime falls within the past `d` days. Each entry includes the
 * cid and the corresponding userid from the ws table.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
async function adminActiveSubs(env, req) {
  if (req.method !== "GET") {
    return r400err("only GET allowed");
  }
  const u = new URL(req.url);
  const dStr = u.searchParams.get("d");

  if (bin.emptyString(dStr)) {
    return r400err("subs: missing d (days)");
  }

  const days = parseInt(dStr, 10);
  if (isNaN(days) || days <= 0) {
    return r400err("subs: invalid d; expected positive integer");
  }

  const db = dbx.db(env);
  const out = await dbx.playActiveSinceDays(db, days);
  if (out == null || !out.success) {
    return r400err("subs: db error");
  }

  const subs = [];
  for (const row of out.results || []) {
    let metadb = null;
    try {
      metadb = row.meta != null ? JSON.parse(row.meta) : null;
    } catch (_) {
      metadb = row.meta;
    }

    subs.push({
      cid: row.cid || null,
      userid: row.userid || null,
      purchasetoken: row.purchasetoken || null,
      linkedtoken: row.linkedtoken || null,
      play_ctime: row.play_ctime || null,
      play_mtime: row.play_mtime || null,
      ws_ctime: row.ws_ctime || null,
      ws_mtime: row.ws_mtime || null,
      meta: metadb,
    });
  }

  return r200j({ days, count: subs.length, subs });
}

/**
 * Main admin handler. Authenticates the request and dispatches to the
 * appropriate sub-handler.
 * @param {any} env - Worker environment
 * @param {Request} req - The incoming request
 * @returns {Promise<Response>}
 */
export async function handleAdmin(env, req) {
  const tsStr = req.headers.get(adminTsHeader);
  const tsMillis = parseInt(tsStr, 10);
  const nowMs = Date.now();
  const diffMs = Math.abs(nowMs - tsMillis);
  if (!isNaN(tsMillis) && diffMs > adminTokenWindowMs) {
    log.e(`admin: ${tsStr} out of window of ${nowMs} (${diffMs}ms)`);
    return r403err("retry");
  }

  // Step 1: authenticate
  const ok = await authenticate(env, req);
  if (!ok) {
    return r401err("unauthorized");
  }

  // Step 2: dispatch based on URL path and query params
  const u = new URL(req.url);
  const p = u.pathname.split("/");

  // p = ["", "a", "ws"] for /a/ws, or ["", "a", ...]
  const x = p[2] ? p[2].toLowerCase() : "";

  if (x === wsresource) {
    const x2 = p[3] ? p[3].toLowerCase() : "";
    if (x2 === wsuser) {
      return await adminUpdateUser(env, req);
    }
    if (x2 === wsentitlement) {
      return await adminUpdateWsEntitlement(env, req);
    }
    if (x2 === wsplaytoken) {
      return await adminPlayPurchaseState(env, req);
    }
    if (x2 === wsplayack) {
      return await adminPlayAcknowledgePurchase(env, req);
    }

    const q = u.searchParams;
    const hasPay = q.has(rawpaymentsquery);
    const hasDate = q.has(paymentstatsdate);

    if (hasPay && hasDate) {
      return await adminMonthlyStats(env, req);
    } else if (hasPay) {
      return await adminRawPayments(env, req);
    } else {
      // ?cid= endpoint
      return await adminSession(env, req);
    }
  }

  if (x === subsresource) {
    return await adminActiveSubs(env, req);
  }

  return r400err(`unknown resource ${x}`);
}
