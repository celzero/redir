/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// should NOT import any other local classes

import { AsyncLocalStorage } from "node:async_hooks";

export class ExecCtx {
  /**
   * @param {any} env - Worker environment
   * @param {boolean} test - Whether this is a test call
   * @param {string} obstoken - Obfuscated purchase token
   */
  constructor(env, test, obstoken = "") {
    /**
     * @type {any} - The Workers environment.
     */
    this.env = env || null;
    /**
     * @type {boolean} - Whether this is a test call.
     * @default false
     */
    this.test = test || false;
    /**
     * @type {string} - Obfuscated purchase token.
     */
    this.obstoken = obstoken;
  }
}

/** @type {AsyncLocalStorage<ExecCtx>} - nodejs.org/api/async_context.html*/
export const als = new AsyncLocalStorage();

/**
 * @returns {string}
 */
export function obsToken() {
  /** @type {ExecCtx} */
  const cfg = als.getStore();
  return cfg?.obstoken || "";
}

/**
 * @returns {any?} - The Workers environment.
 */
export function workersEnv() {
  /** @type {ExecCtx} */
  const cfg = als.getStore();
  return cfg?.env || null;
}

/**
 * @returns {string} - CF Ray ID
 */
export function rayId() {
  /** @type {ExecCtx} */
  const cfg = als.getStore();
  return cfg?.env?.CF_RAY || "";
}

/**
 * Appends ray id to input string if available in execution context.
 * @param {string} s - string to append ray id to
 * @returns {string} - input string with ray id appended if available
 */
export function appendRayId(s) {
  const ray = rayId();
  if (ray) {
    return `${s} (ray: ${ray})`;
  }
  return s;
}

/**
 * @returns {boolean} - Whether this ExecCtx is in test domain.
 */
export function testmode() {
  /** @type {ExecCtx} */
  const cfg = als.getStore();
  return cfg?.test || false;
}

/**
 * @returns {boolean} Whether the code expects account identifier to never
 * change between subscription renewals or onetime purchases.
 */
export function accountIdentifiersImmutable() {
  return true;
}

/**
 *
 * @param {any} env - Workers environment
 * @param {Request} r - The incoming request, used to extract any relevant info for env setup
 * @returns {any} - Wrapped environment with defaults set
 */
export function wrap(env, r) {
  if (env == null) env = {};

  if (env.REDIR_CATCHALL == null) {
    env.REDIR_CATCHALL = "https://rethinkdns.com/404#r";
  }
  if (env.WENV == null) env.WENV = "prod";
  if (env.MIN_VCODE == null) env.MIN_VCODE = "40";
  if (env.MIN_VCODE_PAID_FEATURES == null) env.MIN_VCODE_PAID_FEATURES = "46";
  if (env.STATUS == null) env.STATUS = "ok";
  if (env.WS_URL == null) env.WS_URL = "";
  if (env.WS_URL_TEST == null) env.WS_URL_TEST = "";

  // set runtime environment variables

  env.TEST = env.WENV !== "prod";

  // bindings
  if (env.REDIRDB == null) env.REDIRDB = null;
  if (env.REDIRDBTEST == null) env.REDIRDBTEST = null;
  if (env.SVCDB == null) env.SVCDB = null;
  if (env.SVCDBTEST == null) env.SVCDBTEST = null;

  if (env.REDIRDB == null)
    env.DB = env.SVCDB; // "rpn" d1 database
  else env.DB = env.REDIRDB; // "rpn"
  if (env.REDIRDBTEST == null)
    env.DBTEST = env.SVCDBTEST; // "rpn-test"
  else env.DBTEST = env.REDIRDBTEST; // "rpn-test"

  if (env.TEN_10s_AC == null) env.TEN_10s_AC = null;
  if (env.TWO_10s_AC == null) env.TWO_10s_AC = null;
  if (env.THOUSAND_10s_AC == null) env.THOUSAND_10s_AC = null;

  // secrets
  if (env.STRIPE_API_KEY == null) env.STRIPE_API_KEY = null;
  if (env.STRIPE_WEBHOOK_SECRET == null) env.STRIPE_WEBHOOK_SECRET = null;
  if (env.PRE_SHARED_KEY_SVC == null) env.PRE_SHARED_KEY_SVC = null; // 128-chars-hex
  // unset: env.PUBLIC_KEY_BLINDRSA_(timestamp) = "pub-rsa-pss-hex"
  if (env.GMAPS_API_KEY == null) env.GMAPS_API_KEY = null;
  if (env.GCP_REDIR_SVC_CREDS == null) env.GCP_REDIR_SVC_CREDS = null;
  if (env.KDF_SECRET_D1 == null) env.KDF_SECRET_D1 = null;
  if (env.WS_WL_ID == null) env.WS_WL_ID = null;
  if (env.WS_WL_ID_TEST == null) env.WS_WL_ID_TEST = null;
  if (env.WS_WL_TOKEN == null) env.WS_WL_TOKEN = null;
  if (env.WS_WL_TOKEN_TEST == null) env.WS_WL_TOKEN_TEST = null;

  // developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ray
  env.CF_RAY = r.headers.get("Cf-Ray") || "";
  env.COUNTRY = r.headers.get("CF-IPCountry") || r.cf?.country || "";
  // developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
  env.CITY = r.cf?.city || "";
  env.ASN = r.cf?.asn || "";
  env.ORG = r.cf?.asOrganization || "";
  env.COLO = r.cf?.colo || "";

  return env;
}

export class PlayErr {
  /**
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {string} - error message */
    this.error = payload.error || payload.message || "";
    /** @type {string|undefined} - error details, if any*/
    this.details = payload.details;
    /** @type {string|undefined} - customer identifier */
    this.cid = payload.cid;
    /** @type {string|undefined} - product identifier */
    this.sku = payload.sku;
    /** @type {string|undefined} - obsfuscated purchase identifier*/
    this.purchaseId = payload.purchaseId;
    /** @type {string|undefined} - linked purchase identifier (never obfuscated, test only) */
    this.linkedPurchaseId = payload.linkedPurchaseId;
    /** @type {string|undefined} - order identifier */
    this.orderId = payload.orderId;
    /** @type {string|undefined} - purchase state */
    this.state = payload.state;
    /** @type {string|undefined} - account status */
    this.status = payload.status;
    /** @type {boolean|undefined} - test mode*/
    this.test = payload.test;
    /** @type {string|undefined} - expiry as ISO 8601 string */
    this.expiry = payload.expiry;
    /** @type {string|undefined} - start date as ISO 8601 string */
    this.start = payload.start;
    /** @type {number|undefined} - refund window in days */
    this.windowDays = payload.windowDays;
    /** @type {string[]|undefined} - list of product identifiers in purchase */
    this.allProducts = payload.allProducts;
    /** @type {string[]|undefined} - list of unconsumed product identifiers */
    this.unconsumedProducts = payload.unconsumedProducts;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object} - JSON representation of the error
   */
  get json() {
    const out = {};
    if (this.error) out.error = this.error;
    if (this.message != null) out.message = this.message;
    if (this.details != null) out.details = this.details;
    if (this.cid != null) out.cid = this.cid;
    if (this.sku != null) out.sku = this.sku;
    if (this.purchaseId != null) out.purchaseId = this.purchaseId;
    if (this.linkedPurchaseId != null) {
      out.linkedPurchaseId = this.linkedPurchaseId;
    }
    if (this.orderId != null) out.orderId = this.orderId;
    if (this.state != null) out.state = this.state;
    if (this.status != null) out.status = this.status;
    if (this.test != null) out.test = this.test;
    if (this.expiry != null) out.expiry = this.expiry;
    if (this.start != null) out.start = this.start;
    if (this.windowDays != null) out.windowDays = this.windowDays;
    if (this.allProducts != null) out.allProducts = this.allProducts;
    if (this.unconsumedProducts != null) {
      out.unconsumedProducts = this.unconsumedProducts;
    }
    if (this.ray != null) out.ray = this.ray;
    return out;
  }
}

export class PlayOk {
  /**
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {boolean} - success flag; may be false when ops fails */
    this.success = payload.success ?? true;
    /** @type {string|undefined} - success or failure (not error) message */
    this.message = payload.message;
    /** @type {string|undefined} - customer identifier */
    this.cid = payload.cid;
    /** @type {string|undefined} - product identifier */
    this.sku = payload.sku;
    /** @type {string|undefined} - obsfuscated purchase identifier */
    this.purchaseId = payload.purchaseId;
    /** @type {string|undefined} - linked purchase identifier (never obfuscated, test only) */
    this.linkedPurchaseId = payload.linkedPurchaseId;
    /** @type {string|undefined} - order identifier */
    this.orderId = payload.orderId;
    /** @type {string|undefined} - purchase state */
    this.state = payload.state;
    /** @type {string|undefined} - account status */
    this.status = payload.status;
    /** @type {boolean|undefined} - test mode */
    this.test = payload.test;
    /** @type {string|undefined} - expiry as ISO 8601 string */
    this.expiry = payload.expiry;
    /** @type {string|undefined} - start date as ISO 8601 string */
    this.start = payload.start;
    /** @type {number|undefined} - refund window in days */
    this.windowDays = payload.windowDays;
    /** @type {string|undefined} - cancellation context, if any */
    this.cancelCtx = payload.cancelCtx;
    /** @type {string[]|undefined} - list of product identifiers in purchase */
    this.allProducts = payload.allProducts;
    /** @type {string[]|undefined} - list of unconsumed product identifiers */
    this.unconsumedProducts = payload.unconsumedProducts;
    /** @type {string|undefined} - developer payload */
    this.developerPayload = payload.developerPayload;
    /** @type {boolean|undefined} - had entitlement */
    this.hadEntitlement = payload.hadEntitlement;
    /** @type {boolean|undefined} - deleted entitlement */
    this.deletedEntitlement = payload.deletedEntitlement;
    /** @type {boolean|undefined} - was already fully refunded */
    this.wasAlreadyFullyRefunded = payload.wasAlreadyFullyRefunded;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object} - JSON representation of the success payload
   */
  get json() {
    const out = {};
    if (this.success != null) out.success = this.success;
    if (this.message != null) out.message = this.message;
    if (this.cid != null) out.cid = this.cid;
    if (this.sku != null) out.sku = this.sku;
    if (this.purchaseId != null) out.purchaseId = this.purchaseId;
    if (this.linkedPurchaseId != null) {
      out.linkedPurchaseId = this.linkedPurchaseId;
    }
    if (this.orderId != null) out.orderId = this.orderId;
    if (this.state != null) out.state = this.state;
    if (this.status != null) out.status = this.status;
    if (this.test != null) out.test = this.test;
    if (this.expiry != null) out.expiry = this.expiry;
    if (this.start != null) out.start = this.start;
    if (this.windowDays != null) out.windowDays = this.windowDays;
    if (this.cancelCtx != null) out.cancelCtx = this.cancelCtx;
    if (this.allProducts != null) out.allProducts = this.allProducts;
    if (this.unconsumedProducts != null) {
      out.unconsumedProducts = this.unconsumedProducts;
    }
    if (this.developerPayload != null) {
      out.developerPayload = this.developerPayload;
    }
    if (this.hadEntitlement != null) out.hadEntitlement = this.hadEntitlement;
    if (this.deletedEntitlement != null) {
      out.deletedEntitlement = this.deletedEntitlement;
    }
    if (this.wasAlreadyFullyRefunded != null) {
      out.wasAlreadyFullyRefunded = this.wasAlreadyFullyRefunded;
    }
    if (this.ray != null) out.ray = this.ray;
    return out;
  }
}
