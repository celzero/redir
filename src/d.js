/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

export function wrap(env) {
    if (env == null) env = {};

    if (env.REDIR_CATCHALL == null) env.REDIR_CATCHALL = "https://rethinkdns.com/404#r";
    if (env.WENV == null) env.WENV = "prod";
    if (env.MIN_VCODE == null) env.MIN_VCODE = "40";
    if (env.STATUS == null) env.STATUS = "Ok";

    // bindings
    if (env.DB == null) env.DB = null; // "rpn" d1 database

    // secrets
    if (env.STRIPE_API_KEY == null) env.STRIPE_API_KEY = null;
    if (env.STRIPE_WEBHOOK_SECRET == null) env.STRIPE_WEBHOOK_SECRET = null;
    if (env.PRE_SHARED_KEY_SVC == null) env.PRE_SHARED_KEY_SVC = null; // 128-chars-hex
    // unset: env.PUBLIC_KEY_BLINDRSA_(timestamp) = "pub-rsa-pss-hex"

    return env;
}


