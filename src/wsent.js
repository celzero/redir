/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as bin from "./buf.js";
import { als, ExecCtx } from "./d.js";
import * as dbenc from "./dbenc.js";
import * as dbx from "./sql/dbx.js";

const resourceuser = "Users";
const resourcesession = "Session";
const creatuser = resourceuser + "?session_type_id=4&plan=";

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
class WSUser {
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
     * @type {string} - premium expiry date in yyyy-mm-dd format
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
     * @type {any|null}
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
class WSMetaResponse {
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
   * @param {string} status - "valid" | "invalid" | "banned" | "expired" | "unknown"
   */
  constructor(cid, sessiontoken, status) {
    if (bin.emptyString(cid) || bin.emptyString(sessiontoken)) {
      throw new TypeError("ws: cid and token must not be empty");
    }
    // TODO: validate cid and sessiontoken formats
    /** @type {string} cid - Client ID */
    this.cid = cid; // Client ID
    /** @type {string} sessiontoken - Session token */
    this.sessiontoken = sessiontoken; // Session token
    /** @type {string} status - "valid" | "invalid" | "banned" | "expired" | "unknown" */
    this.status = status || "unknown"; // Status of the entitlement
  }

  toString() {
    return JSON.stringify({
      cid: this.cid,
      sessiontoken: this.sessiontoken,
      status: this.status,
    });
  }
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID
 * @param {Date} expiry - Expiry date of the subscription
 * @param {string} plan - "yearly" | "monthly" | "unknown"
 * @return {Promise<WSEntitlement|null>} - returns the entitlement
 * @throws {Error} - If there is an error generating or retrieving credentials
 */
export async function getOrGenWsEntitlement(env, cid, expiry, plan) {
  const db = dbx.db(env);
  let c = await creds(env, cid);
  if (c == null) {
    // No existing credentials, generate new ones
    const wsuser = await newCreds(env, expiry, plan);
    // Encrypt the session token
    const enctok = await dbenc.encryptText(
      env,
      cid,
      wsuser.userId,
      wsuser.sessionAuthHash
    );
    if (!enctok) {
      throw new Error(`ws: err encrypt(token) for ${cid} on ${expiry} ${plan}`);
    }
    // insert new creds in to the database
    const out = await dbx.insertCreds(db, cid, wsuser.userId, enctok);
    if (!out || !out.success) {
      // on write err, refetch creds
      c = await creds(env, cid); // retry get once
      if (c == null || c.sessiontoken !== wsuser.sessionAuthHash) {
        // TODO: workers analytics failures?
        // delete if the session token does not match
        // or if 'c' is null (TODO: attempt to reinsert instead?)
        await deleteCreds(env, wsuser.sessionAuthHash);
      } // else: fallthrough; uses c if it exists or errors out
    } else {
      // insert ok, use these newly created creds
      c = new WSEntitlement(cid, wsuser.sessionAuthHash, wsStatus(wsuser));
    }
  }
  if (c == null) {
    throw new Error(`ws: err insert or get creds for ${cid} on ${plan}`);
  }
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
  const c = await creds(env, cid);
  if (c == null) {
    return; // No existing credentials, nothing to delete
  }
  // TODO: allow deletion of banned users?
  if (c.status === "banned") {
    throw new Error(`ws: cannot delete banned user ${cid} ${c.status}`);
  }
  const deleted = await deleteCreds(env, c.sessiontoken);
  if (!deleted) {
    throw new Error(`ws: could not delete creds for ${cid}`);
  }
  // TODO: tombstone record the creds?
  const out = await dbx.deleteCreds(db, cid);
  if (!out || !out.success) {
    throw new Error(`ws: db delete err for ${cid} ${c.status}`);
  }
  return; // Successfully deleted the entitlement
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @returns {Promise<WSEntitlement|null>} - [userid, sessiontoken] or null if no existing credentials
 * @throws {Error} - If there is an error decrypting credentials
 */
export async function creds(env, cid) {
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
  if (bin.emptyString(uid) || bin.emptyString(enctok)) {
    return null; // No existing credentials
  }
  const tok = await dbenc.decrypt(env, cid, bin.str2byt2hex(uid), enctok);
  if (bin.emptyString(tok)) {
    throw new Error(`ws: err decrypt(token) for ${cid}`);
  }
  const wsstatus = await credsStatus(env, tok);
  if (
    wsstatus === "valid" || // all okay
    wsstatus === "expired" || // can be renewed
    wsstatus === "banned" || // banned user, do not proceed
    wsstatus === "unknown" // try our luck, maybe it is valid
  ) {
    return new WSEntitlement(cid, tok, wsstatus); // Return existing credentials
  } else if (wsstatus === "invalid") {
    await dbx.deleteCreds(db, cid); // Delete invalid credentials
  }
  logw(`ws: old creds for ${cid} invalid/expired, get new creds?`);
  return null; // need new credentials
}

/**
 * @param {Date} t - time
 * @returns {number} - Number of months until t
 */
function monthsUntil(t) {
  const now = new Date();
  const months =
    (t.getFullYear() - now.getFullYear()) * 12 +
    (t.getMonth() - now.getMonth());
  return months;
}

/**
 * @param {Date} t - time
 * @returns {number} - Number of days until t
 * @throws {TypeError} - If t is not a Date object
 */
function daysUntil(t) {
  if (!(t instanceof Date)) {
    throw new TypeError("daysUntil: t must be a Date object");
  }
  const onedayMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  const diffTime = t.getTime() - Date.now();
  const diffDays = Math.ceil(diffTime / onedayMs); // Convert ms to days
  return diffDays;
}

/**
 *
 * @param {any} env - Worker environment
 * @param {Date} expiry - Expiry date of the entitlement
 * @param {"month"|"year"} plan
 * @returns {Promise<WSUser>} - Returns a WSUser object with new credentials
 * @throws {Error} - If there is an error creating new credentials
 */
async function newCreds(env, expiry, plan) {
  /*
    curl --request POST '.../Users?session_type_id=4&plan=year' \
    --header 'X-WS-WL-ID: ' \
    --header 'X-WS-WL-Token: '
  */
  let execCount = 0;
  const totalMonths = monthsUntil(expiry);
  const totalDays = daysUntil(expiry);
  const requestedPlan = plan;
  if (totalMonths > 9) {
    plan = "year";
    execCount = 1; // 12 month plan
  }
  if (totalMonths <= 0) {
    if (totalDays < 0) {
      throw new Error(`ws: plan expired ${expiry}, cannot create creds`);
    }
    if (totalDays >= 10) {
      plan = "month";
      execCount = 1; // 1 month plan
    } else {
      // TODO: should or should not restrict new creds?
      execCount = 0; // restrict
    }
  } else {
    plan = "month"; // default to monthly plan
    execCount = totalMonths; // x months plan
  }

  logi(
    `new creds until ${expiry}; asked: ${requestedPlan}, assigned: ${plan} + ${execCount}`
  );
  // TODO: repeatedly call execCount times
  const url = apiurl(env) + creatuser + plan;
  const headers = {
    "X-WS-WL-ID": apiaccess(env),
    "X-WS-WL-Token": apisecret(env),
  };
  const r = await fetch(url, { method: "POST", headers });
  if (!r.ok) {
    throw new Error(`could not create new creds: ${r.status} ${r.statusText}`);
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
      "missing userId or sessionAuthHash in response",
      meta.hostName,
      meta.serviceRequestId,
      meta.hostName
    );
  }
  return wsuser; // Return the new credentials
}

/**
 *
 * @param {string} sessiontoken - id:type:timestamp:sig1:sig2
 * @return {Promise<"valid"|"invalid"|"banned"|"expired"|"unknown">} statuses:
 * - "valid" if the session token is ok,
 * - "invalid" if it is not ok,
 * - "expired" if it is ok but expired,
 * - "banned" if the user is banned,
 * - "unknown" if the status is unknown (due to errors)
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
        return wsStatus(wsuser);
      } // else: fallthrough and return "unknown"
    }
    if (r.status === 403) {
      const err = await r.json();
      logw(`credsOK: ${r.status} forbidden: ${err}`);
      if (err.errorCode === 701) {
        return "invalid"; // Session is invalid
      }
    } // else: fallthrough and return "unknown"
    // TODO: do different error codes mean different things here?
  } catch (err) {
    loge(`credsOK: error checking session token:`, err);
  }
  return "unknown"; // Unknown status
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
      if (r.ok) {
        return true; // Successfully deleted
      }
      logw(`deleteCreds: attempt ${tries} failed: ${r.status} ${r.statusText}`);
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
        if (err.errorCode === 701) {
          return true; // Session is invalid, can never delete
        }
      }
    } catch (err) {
      loge(`deleteCreds: attempt ${tries} error:`, err);
      // TODO: queue retry
    }
  }
  return false; // Failed to delete after 3 attempts
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

function logw(...args) {
  console.warn("win:", ...args);
}

function loge(...args) {
  console.error("win:", ...args);
}

function logi(...args) {
  console.info("win:", ...args);
}
