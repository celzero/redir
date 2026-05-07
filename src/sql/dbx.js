/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "../buf.js";
import { dbsession, hasctx, testmode } from "../d.js";
import * as glog from "../log.js";

const log = new glog.Log("dbx");

/**
 * @see developers.cloudflare.com/d1/worker-api/return-object/#d1result
 * ```
 * {
 *  "success": true,
 *  "meta": (object),
 *  "results": [
 *    {
 *        col1: val1,
 *        col2: val2
 *    },
 *    {
 *      col1: val3,
 *      col2: val4
 *    }
 *  ]
 * }
 * ```
 */
export class D1Out {
  constructor(success, meta, results) {
    /**
     * @type {boolean}
     */
    this.success = success;
    /**
     * @type {D1OutMeta|null} - May be null
     */
    this.meta = meta ? new D1OutMeta(meta) : null;

    /**
     * developers.cloudflare.com/d1/worker-api/prepared-statements/#guidance-1
     * @type {Array<Object>} - Expected null for INSERT, UPDATE, DELETE; array of rows for SELECT (may be empty [])
     */
    this.results = results || null;
  }

  static fromJson(json) {
    if (typeof json !== "object" || json == null) {
      throw new TypeError("null or invalid json");
    }
    return new D1Out(json.success, json.meta || null, json.results);
  }
}

/**
 * ```
  "meta": {
    "served_by": "miniflare.db",
    served_by_region: string,
    served_by_primary: boolean, 
    timings: {
      sql_duration_ms: number,
    },
    "duration": 1,
    "changes": 0,
    "last_row_id": 0,
    "changed_db": false,
    "size_after": 8192,
    "rows_read": 4,
    "rows_written": 0
  }
* ```
*/
class D1OutMeta {
  constructor(meta) {
    /**
     * @type {string}
     */
    this.servedby = meta.served_by;
    /**
     * @type {string}
     */
    this.servedbyregion = meta.served_by_region;
    /**
     * @type {boolean}
     */
    this.servedbyprimary = meta.served_by_primary;
    /**
     * @type {Object}
     */
    this.timings = meta.timings || null;
    /**
     * @type {number}
     */
    this.duration = meta.duration;
    /**
     * @type {number}
     */
    this.changes = meta.changes;
    /**
     * @type {number}
     */
    this.lastrowid = meta.last_row_id;
    /**
     * @type {boolean}
     */
    this.changedb = meta.changed_db;
    /**
     * @type {number}
     */
    this.sizeafter = meta.size_after;
    /**
     * @type {number}
     */
    this.rowsread = meta.rows_read;
    /**
     * @type {number}
     */
    this.rowswritten = meta.rows_written;
  }
}

/**
 * Get the D1 session (or raw binding as fallback) based on the environment.
 * When replica is true (default), prefers the pre-created D1 session stored in
 * OuterCtx (dbs / dbstest), which routes reads to a local read replica and
 * forwards writes to primary. Falls back to the raw binding when no session is
 * available or when replica is explicitly false.
 * @param {any} env - Worker environment
 * @param {boolean} replica - when true (default), prefer the outerctx session
 * @returns the D1 session or binding
 * @throws {Error} - if the D1 binding is not available
 */
export function db(env, replica = true) {
  if (replica) {
    const session = dbsession(testmode());
    if (session != null) return session;
  }
  // fallback: raw binding
  if (hasctx()) {
    // testmode() overrides env.TEST
    return dbbinding(env, testmode());
  } else {
    return dbbinding(env, env.TEST);
  }
}

/**
 * Returns a raw D1 binding (no session). Used internally and to create
 * per-request D1 sessions stored in OuterCtx.
 * @param {any} env - Worker environment
 * @param {boolean} testdomain - when true uses the test DB binding
 * @returns {any} raw D1 binding
 * @throws {Error} - if the D1 binding is not available
 */
function dbbinding(env, testdomain = false) {
  const out = testdomain ? env.DBTEST : env.DB;
  if (out == null) throw new Error("database binding missing");
  return out;
}

/**
 * Creates a D1 session from the appropriate binding. Reads are served from the
 * nearest read replica; writes are forwarded to primary.
 * developers.cloudflare.com/d1/worker-api/d1-database/#withsession
 * @param {any} env - Worker environment
 * @param {boolean} testdomain - when true uses the test DB binding
 * @param {string} bookmark - Optional bookmark for the DB session (default: "first-primary")
 * @returns {any} D1 session
 * @throws {Error} - if the D1 binding is not available
 */
export function db2(env, testdomain = false, bookmark = "first-primary") {
  const b = dbbinding(env, testdomain);
  return b.withSession(bookmark);
}

/**
 *
 * @param {any} db - D1 binding
 * @param {string} did - device identifier
 * @param {string} cid - client identifier
 * @param {object?} deviceinfo - raw json with device info
 * @param {number} kind - device kind (0 for phone)
 */
export async function upsertDevice(db, did, cid, deviceinfo, kind) {
  if (db == null || emptyString(did) || emptyString(cid) || kind == null) {
    throw new Error("d1: upsertDevice: db/did/cid/kind missing");
  }
  const q =
    "INSERT INTO devices(did, cid, meta, kind, mtime) VALUES(?, ?, ?, ?, ?)" +
    " ON CONFLICT(did) DO UPDATE SET " +
    "cid=excluded.cid, meta=COALESCE(excluded.meta, devices.meta), kind=excluded.kind, mtime=excluded.mtime";
  const tx = db
    .prepare(q)
    .bind(did, cid, JSON.stringify(deviceinfo), kind, now());
  return run(tx, q);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @returns {Promise<D1Out>} - D1Out object
 */
export async function getDevices(db, cid) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: getDevices: db/cid missing");
  }
  const q = "SELECT * FROM devices WHERE cid = ? AND kind != -1";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @param {string} did - device identifier
 * @returns {Promise<D1Out>} - D1Out with a single row if the device exists and isn't banned
 */
export async function getDevice(db, cid, did) {
  if (db == null || emptyString(cid) || emptyString(did)) {
    throw new Error("d1: getDevice: db/cid/did missing");
  }
  const q = "SELECT * FROM devices WHERE cid = ? AND did = ? AND kind >= 0";
  const tx = db.prepare(q).bind(cid, did);
  return run(tx, q);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @returns {Promise<D1Out>} - D1Out with one row (cid, ctime, kind) if the client
 *   exists and is not banned/removed; empty results otherwise.
 */
export async function getClient(db, cid) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: getClient: db/cid missing");
  }
  const q = "SELECT cid, ctime, kind FROM clients WHERE cid = ? AND kind >= 0";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 *
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @param {string} did - device identifier
 * @param {number} kind - device kind (-1 for banned, -2 for removed)
 * @returns {Promise<D1Out>} - D1Out object
 */
export async function modifyDeviceKind(db, cid, did, kind = -1) {
  if (db == null || emptyString(cid) || emptyString(did) || kind == null) {
    throw new Error("d1: modifyDeviceKind: db/cid/did/kind missing");
  }
  const q = "UPDATE devices SET kind=? WHERE cid = ? AND did = ?";
  const tx = db.prepare(q).bind(kind, cid, did);
  return run(tx, q);
}

/**
 * Insert client data into the clients table if not already present.
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @param {object?} clientinfo - raw json
 * @param {number} kind - 0 for playclient, 1 for playserver, 2 for stripe
 * @returns {Promise<D1Out>} - D1Out object
 * @throws {Error} - if env or cid is null
 */
export async function insertClient(db, cid, clientinfo, kind) {
  if (db == null || emptyString(cid) || kind == null) {
    throw new Error("d1: insertClient: db/cid/kind missing");
  }
  if (clientinfo != null) {
    const q =
      "INSERT OR IGNORE INTO clients(cid, meta, kind, mtime) VALUES(?, ?, ?, ?)";
    const tx = db.prepare(q).bind(cid, JSON.stringify(clientinfo), kind, now());
    return run(tx, q);
  } else {
    const q = "INSERT OR IGNORE INTO clients(cid, kind, mtime) VALUES(?, ?, ?)";
    const tx = db.prepare(q).bind(cid, kind, now());
    return run(tx, q);
  }
}

/**
 * Upsert client data: update kind, meta, and mtime if the client already exists.
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @param {object?} clientinfo - raw json
 * @param {number} kind - 0 for playclient, 1 for playserver, 2 for stripe
 * @returns {Promise<D1Out>} - D1Out object
 * @throws {Error} - if db or cid is null
 */
export async function upsertClient(db, cid, clientinfo, kind) {
  if (db == null || emptyString(cid) || kind == null) {
    throw new Error("d1: upsertClient: db/cid/kind missing");
  }
  if (clientinfo != null) {
    const q =
      "INSERT INTO clients(cid, meta, kind, mtime) VALUES(?, ?, ?, ?)" +
      " ON CONFLICT(cid) DO UPDATE SET" +
      " meta=COALESCE(excluded.meta, clients.meta), kind=excluded.kind, mtime=excluded.mtime";
    const tx = db.prepare(q).bind(cid, JSON.stringify(clientinfo), kind, now());
    return run(tx, q);
  } else {
    const q =
      "INSERT INTO clients(cid, kind, mtime) VALUES(?, ?, ?)" +
      " ON CONFLICT(cid) DO UPDATE SET" +
      " kind=excluded.kind, mtime=excluded.mtime";
    const tx = db.prepare(q).bind(cid, kind, now());
    return run(tx, q);
  }
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - Client ID (hex string)
 * @param {string} token - purchase token (google play)
 * @param {string?} linkedtoken - optional linked token (previous sub)
 * @param {object} info - raw json with subscription info
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - if db is null or cid is null
 */
export async function upsertPlaySub(db, cid, token, linkedtoken, info = null) {
  if (db == null || cid == null || token == null) {
    throw new Error("d1: playsub: db/cid/token missing");
  }
  // limits: 2mb per TEXT field
  // developers.cloudflare.com/d1/platform/limits
  if (info != null) {
    // skip cid update and assume them to match
    const q =
      "INSERT INTO playorders(purchasetoken, meta, cid, linkedtoken, mtime) VALUES(?, ?, ?, ?, ?) " +
      "ON CONFLICT(purchasetoken) DO UPDATE SET " +
      "meta=excluded.meta, linkedtoken=COALESCE(excluded.linkedtoken, playorders.linkedtoken), mtime=excluded.mtime";
    const tx = db
      .prepare(q)
      .bind(token, JSON.stringify(info), cid, linkedtoken, now());
    return run(tx, q);
  } else {
    const q =
      "INSERT OR IGNORE INTO playorders(purchasetoken, cid, linkedtoken, mtime) VALUES(?, ?, ?, ?)";
    const tx = db.prepare(q).bind(token, cid, linkedtoken, now());
    return run(tx, q);
  }
}

/**
 * @param {any} db
 * @param {string} token
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playSub(db, token) {
  if (db == null || token == null) {
    throw new Error("d1: playsub: db/cid/token missing");
  }
  // TODO: limit to androidpublisher#subscriptionPurchase or androidpublisher#subscriptionPurchaseV2 info only
  const q = "SELECT * from playorders where purchasetoken = ?";
  const tx = db.prepare(q).bind(token);
  return run(tx, q);
}

/**
 * unused?
 * @param {any} db
 * @param {string} cid
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playActive(db, cid) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: playActive: db/cid missing");
  }
  const q =
    "SELECT * FROM playorders p WHERE p.cid=?" +
    " AND p.meta IS NOT NULL" +
    " AND ( ( json_extract(p.meta,'$.kind')='androidpublisher#subscriptionPurchaseV2'" +
    " AND json_extract(p.meta,'$.subscriptionState')='SUBSCRIPTION_STATE_ACTIVE' )" +
    " OR ( json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'" +
    " AND json_extract(p.meta,'$.purchaseStateContext.purchaseState')='PURCHASED' ) )" +
    " ORDER BY p.mtime DESC;";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Current unconsumed, may be unacknowleged or acknowledged purchase.
 * @param {any} db
 * @param {string} cid
 * @param {number} limit - Max number of active purchases to retrieve; if -1, retrieves all active purchases
 * @returns {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playOnetimeCurrent(db, cid, limit = -1) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: playOnetimeCurrent: db/cid missing");
  }
  /*
    SELECT * FROM playorders p WHERE p.cid=?
    AND p.meta IS NOT NULL
    AND json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'
    AND json_extract(p.meta,'$.purchaseStateContext.purchaseState') != 'CANCELLED'
    AND EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je
    WHERE json_extract(je.value,'$.productOfferDetails.consumptionState')='CONSUMPTION_STATE_YET_TO_BE_CONSUMED' )
    ORDER BY p.mtime DESC
    LIMIT 20;
   */
  const q =
    "SELECT * FROM playorders p WHERE p.cid=?" +
    " AND p.meta IS NOT NULL" +
    " AND json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'" +
    " AND json_extract(p.meta,'$.purchaseStateContext.purchaseState') != 'CANCELLED'" +
    " AND EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je" +
    " WHERE json_extract(je.value,'$.productOfferDetails.consumptionState')='CONSUMPTION_STATE_YET_TO_BE_CONSUMED' )" +
    " ORDER BY p.mtime DESC" +
    (limit > 0 ? ` LIMIT ${limit}` : "") +
    ";";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Returns up to `limit` fully-consumed (all productLineItems have
 * consumptionState = CONSUMPTION_STATE_CONSUMED) productPurchaseV2 playorder
 * rows for the given cid, ordered most-recently-modified first.
 * Non-cancelled purchases only (purchaseStateContext.purchaseState = PURCHASED).
 *
 * These are purchases the client has already consumed but whose synthetic expiry
 * (start + sku duration) may still lie in the future; i.e. "linked" onetime
 * purchases that convey an active entitlement.
 *
 * @param {any} db
 * @param {string} cid
 * @param {number} limit - Max rows to return; -1 for no limit.
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playConsumedOnetimeForCid(db, cid, limit = -1) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: playConsumedOnetimeForCid: db/cid missing");
  }
  /*
    SELECT * FROM playorders p WHERE p.cid=?
    AND p.meta IS NOT NULL
    AND json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'
    AND json_extract(p.meta,'$.purchaseStateContext.purchaseState')='PURCHASED'
    AND json_extract(p.meta,'$.acknowledgementState')='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
    AND EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je )
    AND NOT EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je
      WHERE json_extract(je.value,'$.productOfferDetails.consumptionState')!='CONSUMPTION_STATE_CONSUMED' )
    ORDER BY p.mtime DESC;
  */
  const q =
    "SELECT * FROM playorders p WHERE p.cid=?" +
    " AND p.meta IS NOT NULL" +
    " AND json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'" +
    " AND json_extract(p.meta,'$.purchaseStateContext.purchaseState')='PURCHASED'" +
    " AND json_extract(p.meta,'$.acknowledgementState')='ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'" +
    // all items must be consumed: no item has consumptionState != CONSUMED
    " AND EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je )" +
    " AND NOT EXISTS ( SELECT 1 FROM json_each(p.meta,'$.productLineItem') je" +
    " WHERE json_extract(je.value,'$.productOfferDetails.consumptionState')!='CONSUMPTION_STATE_CONSUMED' )" +
    " ORDER BY p.mtime DESC" +
    (limit > 0 ? ` LIMIT ${limit}` : "") +
    ";";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Returns up to `limit` playorder rows for the given cid, ordered by mtime desc.
 * @param {any} db
 * @param {string} cid
 * @param {number} limit - Max rows to return (1–20); use -1 for no limit.
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playByCid(db, cid, limit = -1) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: playByCid: db/cid missing");
  }
  const q =
    "SELECT * FROM playorders WHERE cid = ? ORDER BY mtime DESC" +
    (limit > 0 ? ` LIMIT ${limit}` : "") +
    ";";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Returns up to `limit` active playorder rows for the given cid, ordered by mtime desc.
 * A row is considered active if:
 *  - it is a subscriptionPurchaseV2 with subscriptionState = SUBSCRIPTION_STATE_ACTIVE, or
 *  - it is a productPurchaseV2 with purchaseStateContext.purchaseState = PURCHASED
 * @param {any} db
 * @param {string} cid
 * @param {number} limit - Max rows to return (1–20); use -1 for no limit.
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function playActiveByCid(db, cid, limit = -1) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: playActiveByCid: db/cid missing");
  }
  const q =
    "SELECT * FROM playorders p WHERE p.cid=?" +
    " AND p.meta IS NOT NULL" +
    " AND ( ( json_extract(p.meta,'$.kind')='androidpublisher#subscriptionPurchaseV2'" +
    " AND json_extract(p.meta,'$.subscriptionState')='SUBSCRIPTION_STATE_ACTIVE' )" +
    " OR ( json_extract(p.meta,'$.kind')='androidpublisher#productPurchaseV2'" +
    " AND json_extract(p.meta,'$.purchaseStateContext.purchaseState')='PURCHASED' ) )" +
    " ORDER BY p.mtime DESC" +
    (limit > 0 ? ` LIMIT ${limit}` : "") +
    ";";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * @param {any} db
 * @param {string} token
 * @return {Promise<D1Out>} - D1Out object
 * @throws {Error} - on invalid args
 */
export async function firstLinkedPurchaseTokenEntry(db, token) {
  if (db == null || token == null) {
    throw new Error("d1: playsub: db/cid/token missing");
  }
  const q =
    "SELECT * from playorders where linkedtoken = ? ORDER BY mtime DESC LIMIT 1";
  const tx = db.prepare(q).bind(token);
  return run(tx, q);
}

/**
 *
 * @param {any} db
 * @param {string} cid
 * @returns {Promise<D1Out>} - D1Out object
 * @throws {Error} - if db is null or cid is null
 */
export async function wsCreds(db, cid) {
  if (db == null || cid == null) {
    throw new Error("d1: wsCreds: db/cid missing");
  }
  const q = "SELECT * FROM ws WHERE cid = ?";
  const tx = db.prepare(q).bind(cid);
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#first
  return run(tx, q);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - Client ID (hex string)
 * @param {string} userid - WS User ID
 * @param {string} sessiontoken - encrypted session token (hex string)
 * @returns {Promise<D1Out>} - D1Out object
 * @throws {Error} - if db, cid, userid, or sessiontoken is null
 */
export async function insertCreds(db, cid, userid, sessiontoken) {
  if (
    db == null ||
    emptyString(cid) ||
    emptyString(userid) ||
    emptyString(sessiontoken)
  ) {
    throw new Error("d1: wsInsertCreds: db/cid/userid/sessiontoken missing");
  }
  // fails if cid is already in the table
  const q =
    "INSERT INTO ws (cid, sessiontoken, userid, mtime) VALUES(?, ?, ?, ?)";
  const tx = db.prepare(q).bind(cid, sessiontoken, userid, now());
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#run
  return run(tx, q);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - Client ID (hex string)
 * @returns
 */
export async function deleteCreds(db, cid) {
  if (db == null || cid == null) {
    throw new Error("d1: wsDeleteCreds: db/cid missing");
  }
  // will cascade delete matching cid from wsperma table
  const q = "DELETE FROM ws WHERE cid = ?";
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Retrieves the wsperma row whose did matches, if any.
 * @param {any} db - D1 binding
 * @param {string} did - device identifier
 * @returns {Promise<D1Out>}
 */
export async function deletePermasByPubkeys(db, pubkeys) {
  if (db == null || !Array.isArray(pubkeys) || pubkeys.length === 0) {
    throw new Error("d1: deletePermasByPubkeys: db/pubkeys missing or empty");
  }
  const placeholders = pubkeys.map(() => "?").join(",");
  const q = `DELETE FROM wsperma WHERE pubkey IN (${placeholders})`;
  const tx = db.prepare(q).bind(...pubkeys);
  return run(tx, q);
}

/**
 * Retrieves all wsperma rows for a given cid, ordered oldest-first.
 * @param {any} db - D1 binding
 * @param {string} cid - client identifier
 * @returns {Promise<D1Out>}
 */
export async function getPermasByCid(db, cid, limit = 10) {
  if (db == null || emptyString(cid)) {
    throw new Error("d1: getPermasByCid: db/cid missing");
  }
  const q =
    "SELECT * FROM wsperma WHERE cid = ? ORDER BY ctime ASC" +
    (limit > 0 ? ` LIMIT ${limit}` : "");
  const tx = db.prepare(q).bind(cid);
  return run(tx, q);
}

/**
 * Inserts or updates a wsperma row identified by pubkey.
 * On conflict the did and meta columns are updated; cid and ctime are preserved.
 * @param {any} db - D1 binding
 * @param {string} pubkey - WG public key (std base64, 44 chars)
 * @param {string} did - device identifier
 * @param {string} cid - client identifier
 * @param {string} encmeta - encrypted config json (ivtaggedciphertext hex)
 * @returns {Promise<D1Out>}
 */
export async function upsertPerma(db, pubkey, did, cid, encmeta) {
  if (
    db == null ||
    emptyString(pubkey) ||
    emptyString(did) ||
    emptyString(cid) ||
    emptyString(encmeta)
  ) {
    throw new Error("d1: upsertPerma: db/pubkey/did/cid/encmeta missing");
  }
  const q =
    "INSERT INTO wsperma(pubkey, did, cid, meta, mtime) VALUES(?, ?, ?, ?, ?)" +
    " ON CONFLICT(pubkey) DO UPDATE SET did=excluded.did, meta=excluded.meta, mtime=excluded.mtime";
  const tx = db.prepare(q).bind(pubkey, did, cid, encmeta, now());
  return run(tx, q);
}

/**
 * Assigns did to a wsperma row that currently has did = NULL (i.e. the
 * device was deleted and the FK set the column to NULL).  Only updates rows
 * where did IS NULL to avoid accidentally overwriting an active assignment.
 * @param {any} db - D1 binding
 * @param {string} pubkey - WG public key to re-assign
 * @param {string} did - new device identifier
 * @returns {Promise<D1Out>}
 */
export async function reassignPermaDid(db, pubkey, did) {
  if (db == null || emptyString(pubkey) || emptyString(did)) {
    throw new Error("d1: reassignPermaDid: db/pubkey/did missing");
  }
  const q =
    "UPDATE wsperma SET did = ?, mtime = ? WHERE pubkey = ? AND did IS NULL";
  const tx = db.prepare(q).bind(did, now(), pubkey);
  return run(tx, q);
}

/**
 * developers.cloudflare.com/d1/worker-api/prepared-statements/#run
 * @param {any} tx - D1 prepared statement
 * @param {string} [sql] - optional SQL query string for logging
 * @returns {Promise<D1Out>} - D1Out object
 */
async function run(tx, sql = "") {
  // TODO: retries?
  const out = D1Out.fromJson(await tx.run());
  log.d(
    `${sql} <> ${out.meta?.servedby} (${out.meta?.servedbyregion}) mod? ${out.meta?.changedb} r/w ${out.meta?.rowsread}/${out.meta?.rowswritten} - ${out.meta?.duration}ms`,
  );
  return out;
}

/**
 * @returns {string} - current timestamp in ISO format
 */
function now() {
  return new Date().toISOString();
}

/**
 * SQLite DATETIME is not in ISO format but is in UTC.
 * @param {string} datestr - non-ISO date string of form "2025-07-09 19:57:41"
 * @returns {Date} - Date object with UTC timezone ex: 2025-07-09T19:57:41Z
 */
export function sqliteutc(datestr) {
  if (emptyString(datestr)) {
    return new Date();
  }
  // convert to ISO format
  const parts = datestr.split(" ");
  if (parts.length !== 2) {
    return new Date(datestr); // return as-is if not in expected format
  }
  const [date, time] = parts;
  return new Date(`${date}T${time}Z`);
}
