// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import { testmode } from "./d.js";
import { hmackey3, hmacsign } from "./hmac.js";
import * as glog from "./log.js";
import {
  cid,
  consumejson,
  contentlen,
  r200j,
  r400err,
  r401err,
  r403err,
} from "./req.js";
import { creds, resourcesession, resourceuser } from "./wsent.js";

const log = new glog.Log("admin");

const adminTokenHeader = "x-rethink-app-admin-token";
const adminTsHeader = "x-rethink-app-admin-ts";
const adminTokenWindowMs = 100 * 1000; // +/- 100 seconds

const wsSessionPath = "/" + resourcesession;
const wsRawPaymentsPath = "/WhitelabelPayments/rawpayments";
const wsStatsPath = "/WhitelabelPayments/stats/";
const wsUsersPath = "/" + resourceuser;

const wsresource = "ws";
const wsuser = "u";
const rawpaymentsquery = "pay";
const paymentstatsdate = "date";

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
function buildTargetUrl(env, req, path, extraLocalParams = []) {
  const targetUrl = new URL(wsBaseUrl(env) + path);
  const u = new URL(req.url);
  const skip = new Set([...localQueryParams, ...extraLocalParams]);
  for (const [k, v] of u.searchParams.entries()) {
    if (!skip.has(k)) {
      targetUrl.searchParams.set(k, v);
    }
  }
  return targetUrl;
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

  // check time window: +/- 30s from now
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
  const c = cid(req);

  if (bin.emptyString(c)) {
    return r400err("sess: missing cid");
  }

  const cred = await creds(env, c, "adminsess", "any");
  if (cred == null) {
    return r400err("sess: no ws creds for cid");
  }

  const sessiontoken = cred.sessiontoken;

  const targetUrl = buildTargetUrl(env, req, wsSessionPath);
  const headers = buildHeaders(req);
  headers.set("Authorization", `Bearer ${sessiontoken}`);

  log.d("sess: forwarding...", targetUrl.href);

  try {
    const r = await fetch(targetUrl, { method: "GET", headers });

    log.d("sess: response...", targetUrl.href, r.status, contentlen(r));

    const j = await consumejson(r);
    if (j == null) {
      return r400err(`sess: empty response (${r.status})`);
    }
    j.session_auth_hash = sessiontoken;
    j.test = cred.test;
    j.exp = cred.expiry;
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
  const targetUrl = buildTargetUrl(env, req, wsRawPaymentsPath);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("pay: forwarding...", targetUrl.href);

  try {
    const r = await fetch(targetUrl, { method: "GET", headers });

    log.d("pay: response...", targetUrl.href, r.status, contentlen(r));

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
  const u = new URL(req.url);
  const date = u.searchParams.get("date");

  if (bin.emptyString(date)) {
    return r400err("stats: missing date (yyyy-mm)");
  }

  // Basic validation: yyyy-mm format
  if (!/^\d{4}-\d{2}$/.test(date)) {
    return r400err("stats: invalid date format; expected yyyy-mm");
  }

  const targetUrl = buildTargetUrl(env, req, wsStatsPath + date, ["date"]);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("stats: forwarding...", targetUrl.href);

  try {
    const r = await fetch(targetUrl, { method: "GET", headers });

    log.d("stats: response...", targetUrl.href, contentlen(r));

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

  if (bin.emptyString(c)) {
    return r400err("update: missing cid");
  }

  const cred = await creds(env, c, "adminupdate", "any");
  if (cred == null) {
    return r400err("update: no ws creds for cid");
  }

  if (bin.emptyString(cred.sessiontoken)) {
    return r400err("update: missing sessiontoken for cid");
  }

  const sessiontoken = cred.sessiontoken;

  const targetUrl = buildTargetUrl(env, req, wsUsersPath);
  const [wlId, wlToken] = wsWlHeaders(env);
  const headers = buildHeaders(req);
  headers.set("Authorization", `Bearer ${sessiontoken}`);
  headers.set("X-WS-WL-ID", wlId);
  headers.set("X-WS-WL-Token", wlToken);

  log.d("update: forwarding...", targetUrl.href);

  try {
    const r = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
    });

    log.d("update: response...", targetUrl.href, r.status, contentlen(r));

    return new Response(r.body, r);
  } catch (err) {
    log.e("update: fetch err", err);
    return r400err(`update: ${err.message}`);
  }
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

  return r400err(`unknown resource ${x}`);
}
