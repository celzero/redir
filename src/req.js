/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  PlayErr,
  PlayOk,
  ResErr,
  ResOK,
  d1sessionHeader,
  d1sessionHeaderTest,
  request as outerReq,
  url as outerUrl,
} from "./d.js";
import { Log } from "./log.js";

export const defaultcc = "us";
export const unknown = "unknown";
// device token
export const didTokenHeader = "x-rethink-app-did-token";
// client identifier
export const cidHeader = "x-rethink-app-cid";
// device identifier
export const didHeader = "x-rethink-app-did";
// purchase token
export const purchaseTokenHeader = "x-rethink-app-purchase-token";
// d1 session header prod (replica bookmark)
export const dbSessionHeader = d1sessionHeader;
// d1 session header test (replica bookmark)
export const dbSessionHeaderTest = d1sessionHeaderTest;

const log = new Log("req");

/**
 * Get the client IP address from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - The client IP address, if available.
 */
export function clientIp(req) {
  const cfclient6 = req.headers.get("CF-Connecting-IPv6");
  const cfclient4 = req.headers.get("CF-Connecting-IP");
  // prefer IPv6 if available as IPv4 may be Cloudflare's pseudo-IPv4
  // developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ipv6
  if (cfclient6) {
    return cfclient6;
  }
  if (cfclient4) {
    return cfclient4; // fallback to IPv4
  }
  return unknown; // if neither header is present
}

/**
 * Get the country from the request headers.
 * developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
 * @param {Request} req - The incoming request object.
 * @param {string?} fallback - The fallback country code to return if not available in headers.
 * @returns {string|"us"} - Country, if any.
 */
export function country(req, fallback = defaultcc) {
  if (req.cf && req.cf.country) {
    return req.cf.country.toLowerCase();
  }
  return fallback;
}

/**
 * Get the AS Organization from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - AS Organization, if any.
 */
export function asorg(req) {
  if (req.cf && req.cf.asOrganization) {
    return req.cf.asOrganization;
  }
  return unknown;
}

/**
 * Get the city from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - City, if any.
 */
export function city(req) {
  if (req.cf && req.cf.city) {
    return req.cf.city;
  }
  return unknown;
}

/**
 * Get the Cloudflare colo from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - Colo, if any.
 */
export function colo(req) {
  if (req.cf && req.cf.colo) {
    return req.cf.colo;
  }
  return unknown;
}

/**
 * Get the region from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - Region, if any.
 */
export function region(req) {
  if (req.cf && req.cf.region) {
    return req.cf.region;
  }
  return unknown;
}

/**
 * @param {Request} req - The incoming request object.
 * @returns {string|"unknown"} - Postal code, if any.
 */
export function postalcode(req) {
  if (req.cf && req.cf.postalCode) {
    return req.cf.postalCode;
  }
  return unknown;
}

/**
 * Returns the given request if provided, otherwise falls back to the request
 * captured in the outer async-local-storage context. Returns null if neither
 * is available.
 * @param {Request|null|undefined} req
 * @returns {Request|null}
 */
function getreq(req) {
  if (req != null && req instanceof Request) return req;
  return outerReq() || null;
}

/**
 * Returns the pre-parsed URL from OuterCtx if available, otherwise falls back
 * to parsing the URL from the request via getreq(). Returns null if neither
 * is available.
 * @param {Request|null|undefined} req
 * @returns {URL|null}
 */
function geturl(req) {
  const u = outerUrl();
  if (u != null) return u;
  const r = getreq(req);
  if (r == null) return null;
  return new URL(r.url);
}

/**
 * Returns the cid from the "x-rethink-app-cid" header, falling back to
 * the "cid" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function cid(req) {
  const r = getreq(req);
  if (r != null) {
    const h = r.headers.get(cidHeader);
    if (h != null && h.length > 0) return h;
  }
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("cid");
}

/**
 * Returns the "did" from the "x-rethink-app-did" header, falling back to
 * the "did" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function did(req) {
  const r = getreq(req);
  if (r != null) {
    const h = r.headers.get(didHeader);
    if (h != null && h.length > 0) return h;
  }
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("did");
}

/**
 * Returns true when the "test" URL query parameter is present.
 * @param {Request?} req
 * @returns {boolean}
 */
export function isTest(req) {
  const u = geturl(req);
  if (u == null) return false;
  return u.searchParams.has("test");
}

/**
 * Returns the purchase token from the "x-rethink-app-purchase-token" header,
 * falling back to the "purchaseToken" (or lowercase "purchasetoken") URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function purchaseToken(req) {
  const r = getreq(req);
  if (r != null) {
    const h = r.headers.get(purchaseTokenHeader);
    if (h != null && h.length > 0) return h;
  }
  const u = geturl(req);
  if (u == null) return null;
  const p = u.searchParams;
  return p.get("purchaseToken") || p.get("purchasetoken") || null;
}

/**
 * Returns the product / SKU identifier from the "sku", "productId", or
 * "productid" URL query parameter (first non-empty value wins).
 * @param {Request?} req
 * @returns {string|null}
 */
export function sku(req) {
  const u = geturl(req);
  if (u == null) return null;
  const p = u.searchParams;
  return p.get("sku") || p.get("productId") || p.get("productid") || null;
}

/**
 * Returns the "force" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function force(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("force");
}

/**
 * Returns the "vcode" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function vcode(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("vcode");
}

/**
 * Returns the "clientkind" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function clientKind(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("clientkind");
}

/**
 * Returns the "devicekind" URL query parameter.
 * @param {Request?} req
 * @returns {string|null}
 */
export function deviceKind(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("devicekind");
}

/**
 * Returns the "rpn" URL query parameter (WebSocket forward routing key).
 * @param {Request?} req
 * @returns {string|null}
 */
export function rpn(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("rpn");
}

/**
 * Returns true when the "active" URL query parameter is present.
 * @param {Request?} req
 * @returns {boolean}
 */
export function activeOnly(req) {
  const u = geturl(req);
  if (u == null) return false;
  return u.searchParams.has("active");
}

/**
 * Returns the "tot" URL query parameter (numeric limit hint).
 * @param {Request?} req
 * @returns {string|null}
 */
export function tot(req) {
  const u = geturl(req);
  if (u == null) return null;
  return u.searchParams.get("tot");
}

/**
 * Returns the value of the "x-rethink-app-did-token" request header.
 * @param {Request?} req
 * @returns {string|null}
 */
export function didToken(req) {
  const r = getreq(req);
  if (r == null) return null;
  return r.headers.get(didTokenHeader);
}

/**
 * Returns the value of the "Authorization" request header.
 * @param {Request?} req
 * @returns {string|null}
 */
export function authorization(req) {
  const r = getreq(req);
  if (r == null) return null;
  return r.headers.get("Authorization");
}

/**
 * @param {Request|Response} r - incoming unconsumed request or response
 * @returns {Promise<any|null>} - parsed JSON object or null if body is missing/invalid
 */
export async function consumejson(r) {
  try {
    return await r.json();
  } catch (e) {
    log.d("consumejson: no/invalid body", e);
  }
  return null;
}

/** @param {string} msg @returns {Response} */
export function r400txt(msg) {
  return new Response(msg, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

/** @param {string} msg @returns {Response} */
export function r500txt(msg) {
  return new Response(msg, {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}

/** 200 OK with JSON body */
export function r200j(j) {
  const h = { "content-type": "application/json" };
  return new Response(JSON.stringify(j), { status: 200, headers: h });
}

/** 200 OK with JSON body */
export function r200jstr(jstr) {
  const h = { "content-type": "application/json" };
  return new Response(jstr, { status: 200, headers: h });
}

/** 200 OK with JSON body, wrapping payload in PlayOk */
export function r200play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { message: j };
  const payload = j instanceof PlayOk ? j.json : new PlayOk(j).json;
  return new Response(JSON.stringify(payload), { status: 200, headers: h });
}

/** 200 OK with plain-text body (use sparingly; prefer r200ok for JSON) */
export function r200t(txt) {
  const h = { "content-type": "text/plain" };
  return new Response(txt, { status: 200, headers: h });
}

/** 200 OK with JSON body wrapping message in ResOK */
export function r200ok(msg) {
  const h = { "content-type": "application/json" };
  if (typeof msg === "string") msg = { message: msg };
  const payload = msg instanceof ResOK ? msg.json : new ResOK(msg).json;
  return new Response(JSON.stringify(payload), { status: 200, headers: h });
}

/** 204 No Content */
export function r204() {
  return new Response(null, { status: 204 });
}

/** 204 No Content with did-token response header */
export function r204token(token) {
  if (!token) return r204();
  return new Response(null, {
    status: 204,
    headers: { [didTokenHeader]: token },
  });
}

/** 302 Redirect */
export function r302(where) {
  if (!where) return r500txt("missing redirect target");
  return new Response("Redirecting...", {
    status: 302,
    headers: { location: where },
  });
}

/** 400 Bad Request with JSON body */
export function r400err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 400, headers: h });
}

/** 400 Bad Request with JSON body, wrapping payload in PlayErr */
export function r400play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 400, headers: h });
}

/** 401 Unauthorized with JSON body, wrapping payload in PlayErr */
export function r401play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 401, headers: h });
}

/** 401 Unauthorized with JSON body */
export function r401err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 401, headers: h });
}

/** 404 Not Found with JSON body */
export function r404err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 404, headers: h });
}

/** 405 Method Not Allowed with JSON body */
export function r405err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 405, headers: h });
}

/** 405 Method Not Allowed with JSON body, wrapping payload in PlayErr */
export function r405play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 405, headers: h });
}

/** 403 Forbidden with JSON body, wrapping payload in PlayErr */
export function r403play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 403, headers: h });
}

/** 409 Conflict with JSON body, wrapping payload in PlayErr */
export function r409play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 409, headers: h });
}

/** 412 Precondition Failed with JSON body, wrapping payload in PlayErr */
export function r412play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 412, headers: h });
}

/** 421 Misdirected Request with JSON body */
export function r421err(u) {
  const h = { "content-type": "application/json" };
  if (typeof u === "string") u = { error: u };
  const payload = u instanceof ResErr ? u.json : new ResErr(u).json;
  return new Response(JSON.stringify(payload), { status: 421, headers: h });
}

/** 429 Too Many Requests with JSON body */
export function r429err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 429, headers: h });
}

/** 500 Internal Server Error with JSON body */
export function r500err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 500, headers: h });
}

/** 500 Internal Server Error with JSON body, wrapping payload in PlayErr */
export function r500play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 500, headers: h });
}

/** 503 Service Unavailable with JSON body */
export function r503err(w) {
  const h = { "content-type": "application/json" };
  if (typeof w === "string") w = { error: w };
  const payload = w instanceof ResErr ? w.json : new ResErr(w).json;
  return new Response(JSON.stringify(payload), { status: 503, headers: h });
}
