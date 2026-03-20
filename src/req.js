/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { PlayErr, PlayOk, ResErr, ResOK } from "./d.js";
import { Log } from "./log.js";
export const defaultcc = "us";
export const unknown = "unknown";
export const didTokenHeader = "x-rethink-app-did-token";

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
function r400txt(msg) {
  return new Response(msg, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

/** @param {string} msg @returns {Response} */
function r500txt(msg) {
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

/** 409 Conflict with JSON body, wrapping payload in PlayErr */
export function r409play(j) {
  const h = { "content-type": "application/json" };
  if (typeof j === "string") j = { error: j };
  const payload = j instanceof PlayErr ? j.json : new PlayErr(j).json;
  return new Response(JSON.stringify(payload), { status: 409, headers: h });
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
