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

export class OuterCtx extends ExecCtx {
  /**
   * @param {any} env - Worker environment
   * @param {Request} req - Incoming request object
   */
  constructor(env, req) {
    const u = new URL(req.url);
    const test = u.searchParams.has("test");

    super(env, test);

    /**
     * @type {Request} - Incoming request.
     */
    this.req = req;
    /**
     * @type {URL} - Incoming URL.
     */
    this.url = u;
  }
}

/** @type {AsyncLocalStorage<ExecCtx>} - nodejs.org/api/async_context.html */
export const als = new AsyncLocalStorage({ name: "execctx" });

/** @type {AsyncLocalStorage<OuterCtx>} - developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/#multiple-stores */
export const ols = new AsyncLocalStorage({ name: "outerctx" });

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
  /** @type {OuterCtx} */
  const ocfg = ols.getStore();
  if (ocfg?.env != null) return ocfg.env;
  /** @type {ExecCtx} */
  const cfg = als.getStore();
  return cfg?.env || null;
}

/**
 * @returns {Request} - The captured incoming request.
 */
export function request() {
  /** @type {OuterCtx} */
  const ocfg = ols.getStore();
  if (ocfg?.env != null) return ocfg.req;
  return null;
}

/**
 * @returns {string} - CF Ray ID
 */
export function rayId() {
  let ray = "";
  /** @type {OuterCtx} */
  const ocfg = ols.getStore();
  if (ocfg != null) {
    ray = rayid(ocfg.req);
  }

  if (ray == null || ray.length === 0) {
    /** @type {ExecCtx} */
    const cfg = als.getStore();
    return cfg?.env?.CF_RAY || "";
  }

  return ray;
}

/**
 * Get the CF Ray ID from the request headers.
 * @param {Request} req - The incoming request object.
 * @returns {string|""} - CF Ray ID, if any.
 */
function rayid(req) {
  if (req == null) return "";
  return req.headers.get("Cf-Ray") || "";
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
 * @returns {boolean} - Whether any execution context available.
 */
export function hasctx() {
  return ols.getStore() != null || als.getStore() != null;
}

/**
 * @returns {boolean} - Whether this execution is in test domain.
 */
export function testmode() {
  /** @type {OuterCtx} */
  const ocfg = ols.getStore();
  if (ocfg != null) return ocfg.test;

  /** @type {ExecCtx} */
  const cfg = als.getStore();
  if (cfg != null) return cfg.test;

  return false;
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
  if (env.KDF_SECRET_D1_TEST == null) env.KDF_SECRET_D1_TEST = null;
  if (env.KDF_SECRET_CLIENT == null) env.KDF_SECRET_CLIENT = null;
  if (env.KDF_SECRET_CLIENT_TEST == null) env.KDF_SECRET_CLIENT_TEST = null;
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

export class ResOK {
  /**
   * @param {string|object} payload - success message string or object with message field
   */
  constructor(payload = {}) {
    if (typeof payload === "string") payload = { message: payload };
    /** @type {string|undefined} - success message */
    this.message = payload.message;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object}
   */
  get json() {
    const out = {};
    if (this.message != null) out.message = this.message;
    if (this.ray) out.ray = this.ray;
    return out;
  }
}

export class ResErr {
  /**
   * @param {string|object} payload - error message string or object with error/message field
   */
  constructor(payload = {}) {
    if (typeof payload === "string") payload = { error: payload };
    /** @type {string} - error message */
    this.error = payload.error || payload.message || "";
    /** @type {string|undefined} - error details, if any */
    this.details = payload.details;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object}
   */
  get json() {
    const out = {};
    if (this.error) out.error = this.error;
    if (this.details != null) out.details = this.details;
    if (this.ray) out.ray = this.ray;
    return out;
  }
}

export class ResClientReg {
  /**
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {string} - client identifier (hex) */
    this.cid = payload.cid || "";
    /** @type {string|undefined} - device identifier (hex), omitted on client-only re-registration */
    this.did = payload.did;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object}
   */
  get json() {
    const out = {};
    if (this.cid) out.cid = this.cid;
    if (this.did != null) out.did = this.did;
    if (this.ray) out.ray = this.ray;
    return out;
  }
}

export class ResDevice {
  /**
   * Sub-object representing a single registered device; used inside ResDeviceList.
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {string} - obfuscated device identifier */
    this.did = payload.did || "";
    /** @type {object|null} - device metadata */
    this.meta = payload.meta ?? null;
    /** @type {string|null} - creation time as ISO 8601 string */
    this.created = payload.created ?? null;
    /** @type {string|null} - last update time as ISO 8601 string */
    this.updated = payload.updated ?? null;
  }

  /**
   * @returns {object}
   */
  get json() {
    return {
      did: this.did,
      meta: this.meta,
      created: this.created,
      updated: this.updated,
    };
  }
}

export class ResDeviceList {
  /**
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {ResDevice[]} - list of registered devices */
    this.devices = payload.devices || [];
    /** @type {boolean} - test mode flag */
    this.test = payload.test ?? false;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object}
   */
  get json() {
    const ds = this.devices.map((d) => (d instanceof ResDevice ? d.json : d));
    const out = { devices: ds, test: this.test };
    if (this.ray) out.ray = this.ray;
    return out;
  }
}

export class ResProxy {
  /**
   * Response for the proxy-metadata endpoint (p/<vcode>[/wa]).
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {string} - client version code */
    this.vcode = payload.vcode || "";
    /** @type {string} - minimum supported version code */
    this.minvcode = payload.minvcode || "";
    /** @type {boolean} - whether paid features are available for this client */
    this.cansell = payload.cansell ?? false;
    /** @type {string} - client IP address */
    this.ip = payload.ip || "";
    /** @type {string} - client country code (ISO 3166-1 alpha-2) */
    this.country = payload.country || "";
    /** @type {string} - AS organization */
    this.asorg = payload.asorg || "";
    /** @type {string} - client city */
    this.city = payload.city || "";
    /** @type {string} - Cloudflare colo */
    this.colo = payload.colo || "";
    /** @type {string} - client region */
    this.region = payload.region || "";
    /** @type {string} - client postal code */
    this.postalcode = payload.postalcode || "";
    /** @type {string[]} - resolved street addresses (geolocation) */
    this.addrs = payload.addrs || [];
    /** @type {string} - service status */
    this.status = payload.status || "";
    /** @type {object|undefined} - RSA-PSS public key (JWK), undefined when unavailable */
    this.pubkey = payload.pubkey;
    /** @type {string|undefined} - CF Ray ID */
    this.ray = payload.ray || rayId();
  }

  /**
   * @returns {object}
   */
  get json() {
    const out = {
      vcode: this.vcode,
      minvcode: this.minvcode,
      cansell: this.cansell,
      ip: this.ip,
      country: this.country,
      asorg: this.asorg,
      city: this.city,
      colo: this.colo,
      region: this.region,
      postalcode: this.postalcode,
      addrs: this.addrs,
      status: this.status,
    };
    if (this.pubkey !== undefined) out.pubkey = this.pubkey;
    if (this.ray) out.ray = this.ray;
    return out;
  }
}

export class ResStripeWebhook {
  /**
   * Acknowledgement response for Stripe webhook events.
   * @param {object} payload
   */
  constructor(payload = {}) {
    /** @type {boolean} - true when the event was processed (or skipped); false on retry-needed */
    this.received = payload.received ?? false;
  }

  /**
   * @returns {object}
   */
  get json() {
    return { received: this.received };
  }
}
