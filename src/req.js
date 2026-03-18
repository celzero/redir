/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

export const defaultcc = "us";
export const unknown = "unknown";

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
 * Get the CF Ray ID from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|""} - CF Ray ID, if any.
 */
export function rayid(req) {
  return req.headers.get("Cf-Ray") || "";
}

/**
 * @param {Request} req - incoming unconsumed request
 * @returns {Promise<any|null>} - parsed JSON object or null if body is missing/invalid
 */
export async function consumejson(req) {
  try {
    return await req.json();
  } catch (e) {
    log.d(rayid(req), "consumejson: no/invalid body", e);
  }
  return null;
}
