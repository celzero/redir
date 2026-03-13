/*
 * Copyright (c) 2026 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "./buf.js";
import { clientIp } from "./d.js";
import * as glog from "./log.js";

const log = new glog.Log("ac");

/**
 * @param {any} env - Worker environment
 * @param {Request} r - The incoming request
 * @returns {Promise<boolean>} - True if the request is allowed, false otherwise
 */
export async function admit2(env, r) {
  return admit(env, r, 2);
}

/**
 * Check if the request is allowed based on rate limiting.
 * developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit
 * @param {any} env - Worker environment.
 * @param {Request} r - The incoming request.
 * @param {number} rate - The rate limit to apply (2 per 10s or 10 per 10s).
 * @returns {Promise<boolean>} - True if the request is allowed, false otherwise
 */
export async function admit(env, r, rate = 10) {
  const ac10 = env.TEN_10s_AC;
  const ac1000 = env.THOUSAND_10s_AC;
  const ac2 = env.TWO_10s_AC;

  const noac10 = !ac10;
  const noac1000 = !ac1000;
  const noac2 = !ac2;
  // guard against null/undefined before accessing .limit to avoid TypeError
  const noac10func = !noac10 && typeof ac10.limit !== "function";
  const noac1000func = !noac1000 && typeof ac1000.limit !== "function";
  const noac2func = !noac2 && typeof ac2.limit !== "function";
  if (noac10 || noac1000 || noac2 || noac10func || noac1000func || noac2func) {
    console.warn(
      `admit: missing rate limiters: 10? ${noac10}, 1000? ${noac1000}, 2? ${noac2}, 10f? ${noac10func}, 1000f? ${noac1000func}, 2f? ${noac2func}`,
    );
    return true; // fail open
  }

  const ip = clientIp(r);
  const { success } = await ac1000.limit({ key: ip });

  // TODO: strictly determine paths that may bypass cid rate limits.
  const u = new URL(r.url);
  const cid = u.searchParams.get("cid");
  if (!emptyString(cid)) {
    // ignore cid based rate limit if no cid provided.
    // some url paths do not require cid.
    if (rate === 2) {
      const { success } = await ac2.limit({ key: cid });
      if (!success) return false; // rate limit by cid at 2 per 10s
    } else {
      const { success } = await ac10.limit({ key: cid });
      if (!success) return false; // rate limit by cid
    }
  }

  log.d(`admit: ${rayid(r)} ok?`, success, "for", ip, "; c:", cid);

  return success;
}
