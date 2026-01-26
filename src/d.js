/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

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
 * @returns {boolean} - Whether this is using test domain. This is distinct from
 * test purchases.
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

export function wrap(env) {
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

  return env;
}
