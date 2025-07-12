/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "../buf.js";
import { ExecCtx, als } from "../d.js";
import * as glog from "../log.js";

const log = new glog.Log("dbx", 1);

/*
{
  "success": true,
  "meta": (object),
  "results": [
    {
        col1: val1,
        col2: val2
    },
    {
      col1: val3,
      col2: val4
    }
  ]
}*/
// developers.cloudflare.com/d1/worker-api/return-object/#d1result
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
     * @type {Array<Object>} - May be null
     */
    this.results = results || null;
  }

  static fromJson(json) {
    if (typeof json !== "object" || json == null) {
      throw new TypeError("null or inavlid json");
    }
    return new D1Out(json.success, json.meta || null, json.results);
  }
}

/*
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
  },
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
 * Get the D1 binding based on the environment.
 * @param {any} env - Worker environment
 * @param {ExecCtx} cfg - caller configuration
 * @returns the D1 binding based on env.TEST
 * @throws {Error} - if the D1 binding is not available
 * */
export function db(env, cfg = null) {
  let out = env.DB;
  cfg = cfg == null ? als.getStore() : cfg;
  if (cfg != null) {
    // cfg.test overrides env.TEST
    out = cfg.test ? env.DBTEST : env.DB;
  } else if (env.TEST) {
    out = env.DBTEST;
  }
  if (out == null) {
    throw new Error("cid: database binding unavailable");
  }
  return out;
}

/**
 *
 * @param {any} d1 - D1 binding
 * @param {string} cid - client identifier
 * @param {object} clientinfo - raw json
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
    return run(tx);
  } else {
    const q = "INSERT OR IGNORE INTO clients(cid, kind, mtime) VALUES(?, ?, ?)";
    const tx = db.prepare(q).bind(cid, kind, now());
    return run(tx);
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
      "meta=excluded.meta, linkedtoken=excluded.linkedtoken, mtime=excluded.mtime";
    const tx = db
      .prepare(q)
      .bind(token, JSON.stringify(info), cid, linkedtoken, now());
    return run(tx);
  } else {
    const q =
      "INSERT OR IGNORE INTO playorders(purchasetoken, cid, linkedtoken, mtime) VALUES(?, ?, ?, ?)";
    const tx = db.prepare(q).bind(token, cid, linkedtoken, now());
    return run(tx);
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
  const q = "SELECT * from playorders where purchasetoken = ?";
  const tx = db.prepare(q).bind(token);
  return run(tx);
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
    "SELECT * from playorders where linkedtoken = ? ORDER BY mtime LIMIT 1";
  const tx = db.prepare(q).bind(token);
  return run(tx);
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
  const q = "SELECT userid, sessiontoken FROM ws WHERE cid = ?";
  const tx = db.prepare(q).bind(cid);
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#first
  return run(tx);
}

/**
 * @param {any} db - D1 binding
 * @param {string} cid - Client ID (hex string)
 * @param {string} userid - WS User ID
 * @param {string} sessiontoken - encrypted session token (hex string)
 * @returns {Promise<D1Out} - D1Out object
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
  return run(tx);
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
  const q = "DELETE FROM ws WHERE cid = ?";
  const tx = db.prepare(q).bind(cid);
  return run(tx);
}

/**
 * developers.cloudflare.com/d1/worker-api/prepared-statements/#run
 * @param {any} tx - D1 prepared statement
 * @returns {Promise<D1Out>} - D1Out object
 */
async function run(tx) {
  const out = D1Out.fromJson(await tx.run());
  log.d(
    `${tx.sql}: ${out.meta?.servedby} (${out.meta?.servedbyregion}) mod? ${out.meta?.changedb} r/w ${out.meta?.rowsread}/${out.meta?.rowswritten} - ${out.meta?.duration}ms`
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
