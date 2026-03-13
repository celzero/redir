/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "./buf.js";
import * as glog from "./log.js";
import { mincidlength, mindidlength } from "./playorder.js";
import * as dbx from "./sql/dbx.js";

const kindphone = 0;
const log = new glog.Log("reg");

/**
 * @param {any} env - Workers environment
 * @param {Request} req - Incoming request
 */
export async function registerDevice(env, req) {
  if (req.method !== "POST") {
    return r405("method not allowed");
  }
  if (!req.headers.get("Content-Type")?.includes("application/json")) {
    return r400("unsupported content type");
  }

  const ray = glog.rayid(req);
  const url = new URL(req.url);
  const did = url.searchParams.get("did");
  const cid = url.searchParams.get("cid");
  const test = url.searchParams.has("test");

  if (
    emptyString(did) ||
    did.length < mindidlength ||
    !/^[a-fA-F0-9]+$/.test(did) ||
    emptyString(cid) ||
    cid.length < mincidlength ||
    !/^[a-fA-F0-9]+$/.test(cid)
  ) {
    return r400(`${ray} invalid identifiers`);
  }

  let meta = null;
  try {
    meta = await req.json();
  } catch (_) {
    // body missing or not valid JSON; proceed with null meta
  }

  try {
    const db = dbx.db2(env, test);
    const out = await dbx.upsertDevice(db, did, cid, meta || null, kindphone);

    if (out == null || !out.success) {
      return r500(`database error: ${ray}`);
    }
  } catch (e) {
    // ex: Error: D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
    log.e(ray, "registerDevice error:", e);
    return r500(`db error: ${e.message}`);
  }

  log.d(ray, "register", did, "for c:", cid, "meta?", meta, "test?", test);
  // return new Response(`ok: ${ray}`, { status: 200 });
  return retrieveDevices(env, cid, test, ray);
}

/**
 * @param {any} env - Workers environment
 * @param {string} cid - Client identifier
 * @param {boolean} test - Test domain?
 */
export async function retrieveDevices(env, cid, test, ray = "") {
  if (
    emptyString(cid) ||
    cid.length <= mincidlength ||
    !/^[a-fA-F0-9]+$/.test(cid)
  ) {
    return r400("invalid cid");
  }

  const db = dbx.db2(env, test);
  const out = await dbx.getDevices(db, cid);

  log.d(ray, "get dev for c:", cid, "test?", test, "found", out.success);

  if (out == null || !out.success) {
    return r500(`database error: ${ray}`);
  }
  if (out.results == null || out.results.length <= 0) {
    return r404("no devices found");
  }

  const json = [];
  for (const entry of out.results) {
    const did = entry.did || "";
    const meta = entry.meta != null ? JSON.parse(entry.meta) : null;
    const ctime =
      entry.ctime != null ? new Date(entry.ctime).toISOString() : null;
    const mtime =
      entry.mtime != null ? new Date(entry.mtime).toISOString() : null;
    // TODO: define json as class
    json.push({
      did: did.substring(0, 8), // partial
      meta: meta,
      created: ctime,
      updated: mtime,
    });
  }
  return r200j({ devices: json });
}

function r200j(j) {
  const h = { "content-type": "application/json" };
  return new Response(JSON.stringify(j), { status: 200, headers: h }); // ok
}

function r400(w) {
  return new Response(w, { status: 400 }); // bad request
}

function r404(w) {
  return new Response(w, { status: 404 }); // not found
}

function r405(w) {
  return new Response(w, { status: 405 }); // method not allowed
}

function r500(w) {
  return new Response(w, { status: 500 }); // internal server error
}
