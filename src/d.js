/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

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
  if (env.DB == null) env.DB = null; // "rpn" d1 database
  if (env.DBTEST == null) env.DBTEST = null; // "rpn-test" d1 database

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
