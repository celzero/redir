/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const dbdebug = false; // set to true to enable debug logging

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
 * @returns the D1 binding based on env.TEST
 * @throws {Error} - if the D1 binding is not available
 * */
export function db(env) {
  let out = env.DB;
  if (env.TEST) {
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
  if (db == null || cid == null || clientinfo == null || kind == null) {
    throw new Error("d1: insertClient: db/cid/clientinfo/kind missing");
  }
  const q = "INSERT OR IGNORE INTO clients(cid, meta, kind) VALUES(?, ?, ?)";
  const tx = db.prepare(q).bind(cid, JSON.stringify(clientinfo), kind);
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#run
  return run(tx);
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
export async function upsertPlaySub(db, cid, token, linkedtoken, info) {
  if (db == null || cid == null || token == null || info == null) {
    throw new Error("d1: playsub: db/cid/token/info missing");
  }
  // limits: 2mb per TEXT field
  // developers.cloudflare.com/d1/platform/limits
  const q =
    "INSERT INTO playorders(purchasetoken, meta, cid, linkedtoken) VALUES(?, ?, ?, ?) " +
    "ON CONFLICT(purchasetoken) DO UPDATE SET " +
    "meta=excluded.meta, linkedtoken=excluded.linkedtoken";
  const tx = db.prepare(q).bind(token, JSON.stringify(info), cid, linkedtoken);
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#run
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
 *
 * @param {any} db - D1 binding
 * @param {string} cid - Client ID (hex string)
 * @param {string} userid - WS User ID
 * @param {string} sessiontoken - encrypted session token (hex string)
 * @returns {Promise<D1Out} - D1Out object
 * @throws {Error} - if db, cid, userid, or sessiontoken is null
 */
export async function insertCreds(db, cid, userid, sessiontoken) {
  if (db == null || cid == null || userid == null || sessiontoken == null) {
    throw new Error("d1: wsInsertCreds: db/cid/userid/sessiontoken missing");
  }
  // fails if cid is already in the table
  const q = "INSERT INTO ws (cid, sessiontoken, userid) VALUES(?, ?, ?)";
  const tx = db.prepare(q).bind(cid, sessiontoken, userid);
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
  // developers.cloudflare.com/d1/worker-api/prepared-statements/#run
  return run(tx);
}

/**
 * @param {any} tx - D1 prepared statement
 * @returns {Promise<D1Out>} - D1Out object
 */
async function run(tx) {
  const out = D1Out.fromJson(await tx.run());
  logd(tx.sql, out.meta);
  return out;
}

/**
 * @param {string} what
 * @param {D1OutMeta} meta
 */
function logd(what, meta) {
  if (dbdebug) {
    console.debug(
      `D1: ${what}: ${meta.servedby} (${meta.servedbyregion}) mod? ${meta.changedb} r/w ${meta.rowsread}/${meta.rowswritten} - ${meta.duration}ms`
    );
  }
}
