/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as bin from "./buf.js";
import { als, ExecCtx, testmode } from "./d.js";
import * as dbenc from "./dbenc.js";
import * as enc from "./enc.js";
import * as glog from "./log.js";
import * as dbx from "./sql/dbx.js";

const resourceuser = "Users";
const resourcesession = "Session";
const creatuser = resourceuser + "?session_type_id=4&plan=";

const wstokaad = "2:ws.12:sessiontoken"; // len:tablename.len:columnname

const log = new glog.Log("wse");

/*
    {
        "user_id": "string",
        "session_auth_hash": "string",
        "username": "string",
        "traffic_used": 0,
        "traffic_max": 0,
        "status": 1,
        "email": "string",
        "email_status": 0,
        "billing_plan_id": 0,
        "rebill": 0,
        "premium_expiry_date": "yyyy-mm-dd",
        "is_premium": 0,
        "reg_date": 0,
        "last_reset": null,
        "loc_rev": 0,
        "loc_hash": "string"
    }
*/
export class WSUser {
  constructor(json) {
    if (typeof json !== "object" || json == null) {
      throw new TypeError("wsuser: null or invalid json");
    }
    /**
     * @type {string} - user ID (base32)
     */
    this.userId = json.user_id || null;
    /**
     * @type {string} - id:type:timestamp:sig1:sig2
     */
    this.sessionAuthHash = json.session_auth_hash || null;
    /**
     * @type {string} - username (orgname as prefix + "_" + userId as suffix)
     */
    this.username = json.username || null;
    /**
     * @type {number} - in bytes
     */
    this.trafficUsed = json.traffic_used || -1;
    /**
     * @type {number} - if -1, then unlimited
     */
    this.trafficMax = json.traffic_max || -2;
    /**
     * @type {number} - 1 = active, 3 = banned, anything else = inactive
     */
    this.status = json.status || -1;
    /**
     * @type {string} - email address (always null)
     */
    this.email = json.email || null;
    /**
     * @type {number} - (unused)
     */
    this.emailStatus = json.email_status || -1;
    /**
     * @type {number} - billing plan ID (unused; usually 120)
     */
    this.billingPlanId = json.billing_plan_id || -1;
    /**
     * @type {number} - rebill flag (0 = no rebill, 1 = rebill enabled)
     */
    this.rebill = json.rebill || -1;
    /**
     * @type {Date} - premium expiry date in yyyy-mm-dd format
     */
    this.expiry = json.premium_expiry_date
      ? new Date(json.premium_expiry_date)
      : new Date(0);
    /**
     * @type {boolean} - 1 if premium, anything else if free
     */
    this.isPremium = (json.is_premium || -1) == 1;
    /**
     * @type {Date} - registration date (unix timestamp in seconds)
     */
    this.regDate = new Date(json.reg_date * 1000);
    /**
     * @type {string|null} - last reset date "yyyy-mm-dd" or null if not applicable
     */
    this.lastReset = json.last_reset;
    /**
     * @type {number} - location revision
     */
    this.locRev = json.loc_rev;
    /**
     * @type {string} - location hash (hex)
     */
    this.locHash = json.loc_hash;
  }

  jsonable() {
    return {
      user_id: this.userId,
      session_auth_hash: this.sessionAuthHash,
      username: this.username,
      traffic_used: this.trafficUsed,
      traffic_max: this.trafficMax,
      status: this.status,
      email: this.email,
      email_status: this.emailStatus,
      billing_plan_id: this.billingPlanId,
      rebill: this.rebill,
      premium_expiry_date: this.expiry.toISOString().split("T")[0], // yyyy-mm-dd
      is_premium: this.isPremium ? 1 : 0,
      reg_date: Math.floor(this.regDate.getTime() / 1000), // unix timestamp in seconds
      last_reset: this.lastReset,
      loc_rev: this.locRev,
      loc_hash: this.locHash,
    };
  }
}

/*
  {
  "success": 1
  }
*/
class WSSuccessResponse {
  constructor(json) {
    if (typeof json !== "object" || json == null) {
      json = {};
    }
    /** @type {number} - 1 on success, 0 on failure */
    this.success = json.success || 0;
  }
}

/*
    {
        "serviceRequestId": "1749999508862042290",
        "hostName": "staging",
        "duration": "0.29426ms",
        "logStatus": null,
        "md5": "64007038ec43f031bde9c3b14648f9dd"
    }
*/
export class WSMetaResponse {
  constructor(json) {
    if (typeof json !== "object" || json == null) {
      json = {};
    }
    /**
     * @type {string} - service request ID
     */
    this.serviceRequestId = json.serviceRequestId || null;
    /**
     * @type {string} - host name (ex: "staging")
     */
    this.hostName = json.hostName || null;
    /**
     * @type {string} - duration in ms
     */
    this.duration = json.duration || null;
    /**
     * @type {string|null}
     */
    this.logStatus = json.logStatus || null;
    /**
     * @type {string} - MD5 hash of the response
     */
    this.md5 = json.md5 || null;
  }
}

export class WSEntitlement {
  /**
   * @param {string} cid - Client ID (hex)
   * @param {string} sessiontoken - Session token (id:type:timestamp:sig1:sig2)
   * @param {Date} exp - Expiry date of the entitlement
   * @param {string} status - "valid" | "invalid" | "banned" | "expired" | "unknown"
   * @param {boolean} [test=false] - Whether this is a test entitlement
   */
  constructor(cid, sessiontoken, exp, status, test = false) {
    if (bin.emptyString(cid) || bin.emptyString(sessiontoken)) {
      throw new TypeError("ws: cid and token must not be empty");
    }
    /** @type {string} */
    this.kind = "ws#v1";
    // TODO: validate cid and sessiontoken formats
    /** @type {string} cid - Client ID */
    this.cid = cid; // Client ID
    /** @type {string} sessiontoken - session token, may be encrypted */
    this.sessiontoken = sessiontoken; // Session token
    /** @type {Date} expiry */
    this.expiry = exp || new Date(0); // Expiry date of the entitlement
    /** @type {string} status - "valid" | "invalid" | "banned" | "expired" | "unknown" */
    this.status = status || "unknown"; // Status of the entitlement
    /** @type {boolean} - Whether this is a test entitlement */
    this.test = test || false; // Whether this is a test entitlement
  }

  /**
   * Converts the entitlement to be sent to the end client.
   * @param {any} env - Worker environment
   * @returns {Promise<WSEntitlement>} - Returns the entitlement in a client-readable format
   * @throws {Error} - If there is an error encrypting the session token
   */
  async toClientEntitlement(env) {
    return new WSEntitlement(
      this.cid,
      await enc.encryptText(env, this.cid, this.sessiontoken),
      this.expiry,
      this.status,
      this.test
    );
  }
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID
 * @param {Date} exp - Expiry date of the subscription
 * @param {string} plan - "yearly" | "monthly" | "unknown"
 * @param {boolean} [renew=true] - Whether to renew the entitlement if it is expired
 * @return {Promise<WSEntitlement|null>} - returns the entitlement
 * @throws {Error} - If there is an error generating or retrieving credentials
 */
export async function getOrGenWsEntitlement(env, cid, exp, plan, renew = true) {
  let c = await creds(env, cid);
  if (c == null) {
    // No existing credentials, generate new ones
    const wsuser = await newCreds(env, exp, plan);
    let aad = null;
    if (wsuser.regDate * 1000 > dbenc.aadRequirementStartTime) {
      // always true for new creds
      aad = wstokaad;
    }
    // Encrypt the session token
    const enctok = await dbenc.encryptText(
      env,
      cid,
      wsuser.userId,
      aad,
      wsuser.sessionAuthHash
    );
    if (!enctok) {
      const deleted = await deleteCreds(env, wsuser.sessionAuthHash);
      throw new Error(
        `ws: err encrypt(token) for ${cid} deleted? ${deleted} ${wsuser.userId} / ${exp} ${plan}`
      );
    }
    // insert new creds in to the database
    const out = await dbx.insertCreds(dbx.db(env), cid, wsuser.userId, enctok);
    if (!out || !out.success) {
      // on write err, refetch creds
      c = await creds(env, cid); // retry get once
      if (c == null || c.sessiontoken !== wsuser.sessionAuthHash) {
        // TODO: workers analytics failures?
        // delete newly created wsuser if the session token does not match
        // what's stored against this cid in the db.
        // or, if 'c' is null (TODO: attempt to reinsert instead?), which
        // means this new wsuser was not inserted at all.
        const deleted = await deleteCreds(env, wsuser.sessionAuthHash);
        log.e(
          `err insert or get creds for ${cid} deleted? ${deleted} ${wsuser.userId} / ${exp} ${plan}`
        );
      } // else: fallthrough; uses c if it exists or errors out
    } else {
      // insert ok, use these newly created creds
      c = new WSEntitlement(
        cid,
        wsuser.sessionAuthHash,
        wsuser.expiry,
        wsStatus(wsuser),
        testmode()
      );
    }
  }
  if (c == null) {
    throw new Error(`err insert or get creds for ${cid} on ${plan}`);
  }
  // if WSEntitlement has "expired", attempt to renew it
  if (c.status === "expired" || renew) {
    log.w(
      `getOrGen: renewing entitlement for ${c.cid} ${c.status}; force? ${renew}`
    );
    try {
      // No downgrade of the user is necessary if they stop paying
      // (cancel their subscription). Not running new PUT /Users (update)
      // for that account for the new month/year. If users renew at
      // some point later, running a PUT /Users to re-activate the
      // existing account is enough to re-activate their entitlement.
      c = await maybeUpdateCreds(env, c, exp, plan);
    } catch (err) {
      if (c.status === "expired") {
        // existing "c" has expired ... do not ignore refresh/renew error
        throw err;
      } else {
        // existing "c" has not expired ... use it
        log.e(
          `getOrGen: err renewing entitlement for ${c.cid} ${c.status}`,
          err
        );
      }
    }
  }
  log.d(`getOrGen: use existing for ${c.cid} ${c.status}`);
  return c;
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @returns {Promise<void>} - Revokes the entitlement if it exists
 * @throws {Error} - If there is an error deleting the entitlement
 */
export async function deleteWsEntitlement(env, cid) {
  const db = dbx.db(env);
  let c = null;
  try {
    c = await creds(env, cid, "del");
  } catch (_) {}
  if (c == null) {
    return; // No existing credentials, nothing to delete
  }
  // TODO: allow deletion of banned users?
  if (c.status === "banned") {
    throw new Error(`ws: cannot delete banned user ${cid} ${c.status}`);
  }
  const deleted = await deleteCreds(env, c.sessiontoken);
  if (!deleted) {
    // TODO: tombstone db record?
    throw new Error(`ws: could not delete creds for ${cid}`);
  }
  const out = await dbx.deleteCreds(db, cid);
  if (!out || !out.success) {
    throw new Error(`ws: db delete err for ${cid} ${c.status}`);
  }
  return; // Successfully deleted the entitlement
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} op - Reason for getting credentials (default: "get")
 * @returns {Promise<WSEntitlement|null>} - [userid, sessiontoken] or null if no existing credentials
 * @throws {Error} - If there is an error decrypting credentials
 */
export async function creds(env, cid, op = "get") {
  const db = dbx.db(env);
  const out = await dbx.wsCreds(db, cid);
  // TODO: handle !out.success; throw error?
  if (!out.results || out.results.length <= 0) {
    return null; // No existing credentials
  }
  // TODO: types for DB results
  const row = out.results[0];
  const uid = row.userid || null;
  const enctok = row.sessiontoken || null; // encrypted session token
  const ctime = dbx.sqliteutc(row.ctime);
  if (bin.emptyString(uid) || bin.emptyString(enctok)) {
    log.d(`err ${op} creds for ${cid} missing uid or enctok; no-op`);
    return null; // No existing credentials
  }
  const uhex = bin.str2byt2hex(uid);
  let aadhex = null;
  if (ctime.getTime() > dbenc.aadRequirementStartTime) {
    aadhex = bin.str2byt2hex(wstokaad);
  }
  log.d(
    `ws: ${op} creds for ${cid}, uid: ${uhex}, aad: ${aadhex}, enctok: ${enctok}, ctime: ${ctime.toISOString()}`
  );
  const tokhex = await dbenc.decrypt(env, cid, uhex, aadhex, enctok);
  if (bin.emptyString(tokhex)) {
    throw new Error(`ws: err ${op} decrypt(token) for ${cid}`);
  }
  const tok = bin.hex2byt2str(tokhex);
  const [wsstatus, wsuser] = await credsStatus(env, tok);
  // TODO: insert into db depending on "op"?
  // dbx.upsertCredsMeta
  if (
    wsstatus === "valid" || // all okay
    wsstatus === "expired" || // can be renewed
    wsstatus === "banned" || // banned user, do not proceed
    wsstatus === "unknown" // try our luck, maybe it is valid
  ) {
    return new WSEntitlement(cid, tok, wsuser?.expiry, wsstatus, testmode()); // Return existing credentials
  } else if (wsstatus === "invalid") {
    // TODO: also call /Delete? but will it fail anyway?
    await dbx.deleteCreds(dbx.db(env), cid);
  }
  log.w(`cannot ${op} old creds for ${cid} invalid/exp? ${wsstatus}`);
  return null; // need new credentials
}

/**
 * @param {any} env - Worker environment
 * @param {WSEntitlement} c - Existing entitlement
 * @param {Date} subExpiry - Expiry date of the subscription
 * @param {"month"|"year"} requestedPlan - Requested plan
 * @returns {Promise<WSEntitlement>} - Returns updated WSEntitlement object
 * @throws {Error} - If there is an error updating the entitlement
 */
async function maybeUpdateCreds(env, c, subExpiry, requestedPlan) {
  // google play enforces a 1-day grace period after expiry
  const oneDayMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  if (c.expiry.getTime() >= subExpiry.getTime() - oneDayMs) {
    log.d(`updateCreds: no-op; ent > sub: ${c.expiry} > ${subExpiry}`);
    return c; // No need to update, existing expiry is greater than the requested expiry
  }
  /*
  curl --location --request PUT '.../Users?plan=month|year&delete_credentials=0|1' \
    --header 'X-WS-WL-ID: ' \
    --header 'X-WS-WL-Token: ' \
    --header 'Authorization: Bearer ...' \
   */

  const testing = testmode();

  const [plan, execCount] = expiry2plan(subExpiry, testing, c.expiry);

  log.i(
    `update creds until ${subExpiry} from ${c.expiry}; asked: ${requestedPlan}, assigned: ${plan} + ${execCount}`
  );

  if (plan == "unknown" || execCount <= 0) {
    throw new Error(
      `cannot update entitlement; subscription expiring soon: ${subExpiry.toISOString()}`
    );
  }

  // Calling the PUT /Users adds 1 month or 1 year to the expiry date.
  // If expiry date was 2025-07-15, and the PUT request is run anytime
  // before or on this date, and say adds a month, the new expiry date
  // is 2025-08-15. If the PUT request is run again after the account
  // has already expired, and was downgraded (say, on 2025-07-19) it
  // adds 1 month from that date, and new expiry will be 2025-08-19.
  // Issuing subsequent PUT requests would keep adding +1mo (or +1y)
  // to this date. If it's the last day of the month, the +1mo will
  // keep it the same (30th -> 31st -> 30th).
  const url =
    apiurl(env) + resourceuser + "?plan=" + plan + "&delete_credentials=0";
  const headers = {
    "X-WS-WL-ID": apiaccess(env),
    "X-WS-WL-Token": apisecret(env),
    Authorization: `Bearer ${c.sessiontoken}`,
  };
  const r = await fetch(url, { method: "PUT", headers });
  if (!r.ok) {
    const err = await r.json();
    const errstr = JSON.stringify(err);
    log.w(`update creds: ${r.status} forbidden: ${errstr}`);
    throw new Error(`could not update creds: ${r.status} ${errstr}`);
  }
  // data = { data: { ... }, metadata: { ... } }
  /*
  {
    "data": {
        "success": 1
    },
    "metadata": {
        "serviceRequestId": "string",
        "hostName": "string",
        "duration": "string",
        "logStatus": "string",
        "md5": "string"
    }
  }
  */
  const data = await r.json();
  if (!data || typeof data !== "object") {
    throw new Error("invalid response from WS server");
  }
  const meta = new WSMetaResponse(data.metadata);
  const wsdone = new WSSuccessResponse(data.data);
  if (!wsdone || wsdone.success !== 1) {
    throw new Error(
      `upgrade not successful for ${c.cid} expiring on ${c.expiry} [${plan}x${execCount}] (sub expiry: ${subExpiry}) by` +
        ` ${meta.hostName}, ${meta.serviceRequestId}, ${meta.hostName}`
    );
  }
  // TODO: fetch the updated user data
  const [wsstatus, wsuser] = await credsStatus(env, c.sessiontoken);
  // do not expect wsstatus to be "unknown" or "invalid" here
  return new WSEntitlement(
    c.cid,
    c.sessiontoken,
    wsuser?.expiry,
    wsstatus,
    testmode()
  );
}

/**
 * @param {Date} t - time
 * @param {Date} [base=new Date()] - Starting date for calculations
 * @returns {number} - Number of months until t
 */
function monthsUntil(t, base = new Date()) {
  const months =
    (t.getFullYear() - base.getFullYear()) * 12 +
    (t.getMonth() - base.getMonth());
  return months;
}

/**
 * @param {Date} t - time
 * @param {Date} [base=new Date()] - Starting date for calculations
 * @returns {number} - Number of days until t (note <24h = 1 day)
 * @throws {TypeError} - If t is not a Date object
 */
function daysUntil(t, base = new Date()) {
  if (!(t instanceof Date)) {
    throw new TypeError("daysUntil: t must be a Date object");
  }
  const onedayMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  const diffTime = t.getTime() - base.getTime();
  const diffDays = Math.ceil(diffTime / onedayMs); // Convert ms to days
  return diffDays;
}

/**
 *
 * @param {any} env - Worker environment
 * @param {Date} expiry - Expiry date of the entitlement
 * @param {"month"|"year"} requestedPlan
 * @returns {Promise<WSUser>} - Returns a WSUser object with new credentials
 * @throws {Error} - If there is an error creating new credentials
 */
async function newCreds(env, expiry, requestedPlan) {
  /*
    curl --request POST '.../Users?session_type_id=4&plan=year' \
    --header 'X-WS-WL-ID: ' \
    --header 'X-WS-WL-Token: '
  */
  /** @type {ExecCtx} */
  const execctx = als.getStore();
  const testing = execctx ? execctx.test : false;

  const [plan, execCount] = expiry2plan(expiry, testing);

  log.i(
    `new creds until ${expiry}; asked: ${requestedPlan}, assigned: ${plan} + ${execCount}`
  );

  if (plan == "unknown" || execCount <= 0) {
    throw new Error(
      `cannot create entitlement; subscription expiring imminently`
    );
  }

  // TODO: repeatedly call execCount times
  const url = apiurl(env) + creatuser + plan;
  const headers = {
    "X-WS-WL-ID": apiaccess(env),
    "X-WS-WL-Token": apisecret(env),
  };
  const r = await fetch(url, { method: "POST", headers });
  if (!r.ok) {
    const err = await r.json();
    const errstr = JSON.stringify(err);
    log.w(`new creds: ${r.status} forbidden: ${errstr}`);
    throw new Error(`could not create new creds: ${r.status} ${errstr}`);
  }
  // data = { data: { ... }, metadata: { ... } }
  const data = await r.json();
  if (!data || typeof data !== "object") {
    throw new Error("invalid response from WS server");
  }
  const meta = new WSMetaResponse(data.metadata);
  const wsuser = new WSUser(data.data);
  if (!wsuser.userId || !wsuser.sessionAuthHash) {
    throw new Error(
      `new creds: missing user or session ${meta.hostName}, ${meta.serviceRequestId}, ${meta.hostName}`
    );
  }
  return wsuser; // Return the new credentials
}

/**
 *
 * @param {string} sessiontoken - id:type:timestamp:sig1:sig2
 * @return {Promise<["valid"|"invalid"|"banned"|"expired"|"unknown", WSUser]>} statuses:
 * - "valid" if the session token is ok,
 * - "invalid" if it is not ok,
 * - "expired" if it is ok but expired,
 * - "banned" if the user is banned,
 * - "unknown" if the status is unknown (due to errors)
 * WSUser: The entitlement.
 */
async function credsStatus(env, sessiontoken) {
  // curl --request GET 'https://api-staging.windscribe.com/Session'
  // --header 'Authorization: Bearer sessiontoken'
  const url = apiurl(env) + resourcesession;
  const headers = {
    Authorization: `Bearer ${sessiontoken}`,
  };
  try {
    const r = await fetch(url, { method: "GET", headers });
    if (r.ok) {
      const d = await r.json();
      if (d && d.data) {
        const wsuser = new WSUser(d.data);
        return [wsStatus(wsuser), wsuser];
      } // else: fallthrough and return "unknown"
    }
    /* 400 Bad Request
    {
      "errorCode": 6002,
      "errorMessage": "Server error validating session",
      "errorDescription": "Server error validating session",
      "logStatus": null
    }
    */
    if (r.status >= 400) {
      const err = await r.json();
      log.w(`creds status: ${r.status} forbidden: ${JSON.stringify(err)}`);
      if (err.errorCode === 701) {
        return ["invalid", null]; // Session is invalid
      }
      if (err.errorCode === 6002) {
        // TODO: windscribe bug; return "unknown"?
        return ["invalid", null]; // Server error validating session
      }
    } // else: fallthrough and return "unknown"
    // TODO: do different error codes mean different things here?
  } catch (err) {
    log.e(`creds status: error checking session token:`, err);
  }
  return ["unknown", null]; // Unknown status
}

/**
 *
 * @param {WSUser} wsuser
 * @returns {"valid"|"unknown"|"banned"|"expired"|"invalid"}
 */
function wsStatus(wsuser) {
  if (wsuser == null) {
    return "unknown";
  }
  // 1 = active, 3 = banned, anything else = inactive
  if (wsuser.status === 3) {
    return "banned";
  }
  // TODO: handle other wsuser.status values?
  // status is active, check expiry
  return daysUntil(wsuser.expiry) >= 0 ? "valid" : "expired";
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} sessiontoken - to be deleted (id:type:timestamp:sig1:sig2)
 * @returns {Promise<boolean>} true if successfully deleted, false otherwise
 */
async function deleteCreds(env, sessiontoken) {
  /*
    with bearer token "session_auth_hash"
    curl --location --request DELETE '.../Users' \
    --header 'X-WS-WL-ID: ' \
    --header 'X-WS-WL-Token: '
    --header 'Authorization: Bearer session_auth_hash'
    */
  const url = apiurl(env) + resourceuser;
  const headers = {
    "X-WS-WL-ID": apiaccess(env),
    "X-WS-WL-Token": apisecret(env),
    Authorization: `Bearer ${sessiontoken}`,
  };
  for (const tries of [1, 2, 3]) {
    await sleep(tries); // Wait 1s, 2s, 3s
    try {
      const r = await fetch(url, { method: "DELETE", headers });
      /*
        {
          "data": {
              "success": 1
          },
          "metadata": {
              "serviceRequestId": "string",
              "hostName": "string",
              "duration": "string",
              "logStatus": "string",
              "md5": "string"
          }
        }
      */
      if (r.ok) {
        return true; // Successfully deleted
      }
      log.w(
        `deleteCreds: attempt ${tries} failed: ${r.status} ${r.statusText}`
      );
      /* 403 Forbidden
      {
      "errorCode": 701,
      "errorMessage": "Session is invalid",
      "errorDescription": "Submitted session is invalid. Please re-log in",
      "logStatus": null
      }
      */
      if (r.status === 403) {
        const err = await r.json();
        const errstr = JSON.stringify(err);
        log.w(`deleteCreds: attempt ${tries} err: ${errstr}`);
        if (err.errorCode === 701) {
          return true; // Session is invalid, can never delete
        }
      }
    } catch (err) {
      log.e(`deleteCreds: attempt ${tries} error:`, err);
      // TODO: queue retry
    }
  }
  return false; // Failed to delete after 3 attempts
}

/**
 * @param {Date} expiry
 * @param {boolean} [testing=false] - Testing mode?
 * @param {Date} [since=new Date()] - Starting date for calculations
 * @returns {["month"|"year"|"unknown", number]} - plan and multipler (ie, ["month", 6] means a 6mo plan)
 */
function expiry2plan(expiry, testing = false, since = new Date()) {
  let execCount = 0;
  let plan = "unknown";
  const totalMonths = monthsUntil(expiry, since);
  const totalDays = daysUntil(expiry, since);
  if (totalMonths > 9) {
    plan = "year";
    execCount = 1; // 12 month plan
  }
  if (totalMonths <= 0) {
    if (totalDays < 0) {
      // in the past
      throw new Error(`ws: plan expired ${expiry}, cannot create creds`);
    }
    if (totalDays >= 10) {
      plan = "month";
      execCount = 1; // 1 month plan
    } else if (totalDays == 1) {
      if (testing) {
        plan = "month"; // testing, allow
        execCount = 1; // 1 month plan
      } else {
        // may be anywhere between 1s and 1d
        // silent grace period ~24h
        // TODO: if purchase token is unacknowledged, then always
        // generate new creds as the user is unlikely to be a in silent grace period.
        // developer.android.com/google/play/billing/lifecycle/subscriptions#silent-grace-period
        // plan is "unknown"
        execCount = 0;
      }
    } else {
      // TODO: should or should not restrict new creds?
      // plan is "unknown"
      execCount = 0; // restrict
    }
  } else {
    plan = "month"; // default to monthly plan
    execCount = totalMonths; // x months plan
  }
  return [plan, execCount];
}

/**
 * @param {any} env - Worker environment
 * @param {ExecCtx} cfg - caller configuration
 * @returns
 */
function apiurl(env, cfg = null) {
  let out = env.WS_URL;
  cfg = cfg == null ? als.getStore() : cfg;
  if (cfg != null) {
    out = cfg.test ? env.WS_URL_TEST : env.WS_URL;
  } else if (env.TEST) {
    out = env.WS_URL_TEST;
  }
  return out;
}

/**
 * @param {any} env - Worker environment
 * @param {ExecCtx} cfg - caller configuration
 * @returns
 */
function apiaccess(env, cfg = null) {
  let out = env.WS_WL_ID;
  cfg = cfg == null ? als.getStore() : cfg;
  if (cfg != null) {
    out = cfg.test ? env.WS_WL_ID_TEST : env.WS_WL_ID;
  } else if (env.TEST) {
    out = env.WS_WL_ID_TEST;
  }
  return out;
}

/**
 * @param {any} env - Worker environment
 * @param {ExecCtx} cfg - caller configuration
 * @returns
 */
function apisecret(env, cfg = null) {
  let out = env.WS_WL_TOKEN;
  cfg = cfg == null ? als.getStore() : cfg;
  if (cfg != null) {
    out = cfg.test ? env.WS_WL_TOKEN_TEST : env.WS_WL_TOKEN;
  } else if (env.TEST) {
    out = env.WS_WL_TOKEN_TEST;
  }
  return out;
}

async function sleep(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}
