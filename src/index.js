/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as ac from "./ac.js";
import { b64AsBytes, emptyBuf } from "./buf.js";
import * as d from "./d.js";
import { Log } from "./log.js";
import {
  grabLinks,
  grabSupportedCountries,
  krpn,
  ksponsor,
} from "./paylinks.js";
import {
  cancelSubscription,
  googlePlayAcknowledgePurchase,
  googlePlayConsumePurchase,
  googlePlayGetEntitlements,
  googlePlayGetTransaction,
  googlePlayNotification,
  revokeSubscription,
} from "./playorder.js";
import {
  authorizeClient,
  authorizeDevice,
  registerClient,
  registerDevice,
  removeDevice,
} from "./reg.js";
import {
  asorg,
  city,
  clientIp,
  colo,
  consumejson,
  country,
  didTokenHeader,
  postalcode,
  r200j,
  r302,
  r400err as r400,
  r405err as r405,
  r429err as r429,
  r500err as r500,
  r503err as r503,
  region,
  vcode as vcodeOf,
} from "./req.js";
import { finalizeOrder, generateToken, stripeCheckout } from "./rpnorder.js";
import { forwardToWs } from "./wsfwd.js";
import * as xc from "./xc.js";

const urlredirect = "r"; // redirect to dest url
const urlstripe = "s"; // unused? stripe checkout webhook
const urlmoney1 = "mb"; // unused? sign the blind message
const urlmoney2 = "mt"; // unused? generate token
const urlsproxy = "p"; // sproxy metadata
const urlgplay = "g"; // redirect to play store
const crosssvc = "x"; // cross-service calls
const urldevice = "d"; // device registration
const paramwsfwd = "rpn"; // if url param is present, forward to ws

const blindRsaPublicKeyPrefix = "PUBLIC_KEY_BLINDRSA_";

/** @type {Set<string>} */
const supportedCountriesSponsor = grabSupportedCountries(ksponsor);
/** @type {Set<string>} */
const supportedCountriesRpn = grabSupportedCountries(krpn);
/** @type {Map<string, string>} */
const allLinks = grabLinks();

const log = new Log("main");

/**
 * @param {Request} r
 * @param {any} env
 * @param {any} ctx
 * @returns {Promise<Response>}
 */
async function handle(r, env, ctx) {
  const home = env.REDIR_CATCHALL;
  try {
    const url = new URL(r.url);
    const path = url.pathname;

    if (mustWsFwd(url)) {
      if ((await ac.admit(env, r)) === false) {
        return r429("wsf: rate limited");
      }

      const auth = await authorizeDevice(env, r);
      if (!auth.ok) return auth;

      return respond(forwardToWs(env, r), auth);
    }

    if (path == null || path.length === 0) return r302(home);

    // x.tld/a/b/c/ => ["", "a", "b", "c", ""]
    const p = path.split("/");

    if (p.length < 2) return r302(home);

    if (p[1] === urlredirect) {
      // r; redirects
      return redirect(r, url, p, home);
    } else if (p[1] === crosssvc) {
      // x; cross-service calls
      // ex: x/crt
      const p2 = p[2] ? p[2].toLowerCase() : "";
      if (!p2 || p2.length === 0) {
        return r400("x: missing resource");
      }
      if (p2 === "crt") {
        return xc.certfile(env, r);
      }
      return r400(`x: unknown resource ${p2}`);
    } else if (p[1] === urldevice) {
      if ((await ac.admit3(env, r)) === false) {
        return r429("d: rate limited");
      }

      // d; device registration
      const p2 = p[2] ? p[2].toLowerCase() : "";

      if (p2 === "rem") {
        // d/rem?cid=hex&did=hex[&test]
        if (r.method !== "DELETE" && r.method !== "POST") {
          return r405("d/rem: method not allowed");
        }
        return await removeDevice(env, r);
      } else if (p2 === "acc") {
        if (r.method !== "POST") {
          return r405("d/acc: method not allowed");
        }
        // d/acc?kind=[0|1|2|-1|-2][&cid=][&did=]&vcode=[&test]
        // metadata as json in the body
        return await registerClient(env, r);
      } else if (!p2 || p2.length === 0 || p2 === "reg") {
        if (r.method !== "POST") {
          return r405("d/reg: method not allowed");
        }
        // d/reg?did=hex&cid=hex&vcode=[&test]
        // metadata as json in the body
        return await registerDevice(env, r);
      }
    } else if (p[1] === urlstripe) {
      // s; stripe webhook
      const whsec = env.STRIPE_WEBHOOK_SECRET;
      const apikey = env.STRIPE_API_KEY;
      const db = env.DB;
      // opt: p[2] === "checkout"
      return await stripeCheckout(r, db, apikey, whsec);
    } else if (p[1] === urlgplay) {
      // g; play store subs rtdn at g/rtdn
      const p2 = p[2] ? p[2].toLowerCase() : "";
      if (!p2 || p2.length === 0) {
        return r400("g: missing resource");
      }

      if (p2 === "rtdn") {
        return await googlePlayNotification(env, r);
      }

      const vcode = vcodeOf(r);
      if (vcode) {
        const minVCodeNeeded = minvcode(env, "paid-features");
        const cansell = greaterThanEqCmp(vcode, minVCodeNeeded);
        if (!cansell) {
          return r503(`g: app ${vcode} outdated`);
        }
      }

      if ((await ac.admit(env, r)) === false) {
        return r429("g: rate limited");
      }

      if (p2 === "ack") {
        // g/ack/[vcode]?cid&did&purchaseToken&vcode[&force&sku&test]
        if (r.method !== "POST" && r.method !== "GET") {
          return r405("g/ack: method not allowed");
        }
        const auth = await authorizeDevice(env, r);
        if (!auth.ok) return auth;
        return respond(googlePlayAcknowledgePurchase(env, r), auth);
      } else if (p2 === "con") {
        // g/con/[vcode]?cid&did&purchaseToken&vcode[&sku&test]
        if (r.method !== "POST") {
          return r405("g/con: method not allowed");
        }
        const auth = await authorizeDevice(env, r);
        if (!auth.ok) return auth;
        return respond(googlePlayConsumePurchase(env, r), auth);
      } else if (p2 === "ent") {
        // TODO: mere possession of cid is auth, right now
        // will get entitlement for onetime purchase too, if &sku=onetime.tier
        // g/entitlements/[vcode]?cid&did&vcode&test[&sku]
        if (r.method !== "GET") return r405("g/ent: method not allowed");
        const auth = await authorizeDevice(env, r);
        if (!auth.ok) return auth;
        return respond(googlePlayGetEntitlements(env, r), auth);
      } else if (p2 === "stop") {
        // will refund and revoke onetime purchase, if &sku=onetime.tier
        // g/stop/[vcode]?cid&did&purchaseToken&vcode[&sku&test]
        if (r.method !== "POST") {
          return r405("g/stop: method not allowed");
        }
        const auth = await authorizeDevice(env, r);
        if (!auth.ok) return auth;
        return respond(cancelSubscription(env, r), auth);
      } else if (p2 === "refund") {
        // will refund and revoke onetime purchase, if &sku=onetime.tier
        // g/refund/[vcode]?cid&did&purchaseToken&vcode[&sku&test]
        if (r.method !== "POST") {
          return r405("g/refund: method not allowed");
        }
        const auth = await authorizeDevice(env, r);
        if (!auth.ok) return auth;
        return respond(revokeSubscription(env, r), auth);
      } else if (p2 === "tx") {
        // g/tx?cid=&purchaseToken=[&test][&tot=n][&active]
        if (r.method !== "GET") {
          return r405("g/tx: method not allowed");
        }
        const auth = await authorizeClient(env, r);
        if (!auth.ok) return auth;
        return respond(googlePlayGetTransaction(env, r), auth);
      }
      return r400(`g: unknown resource ${p2}`);
    } else if (p[1] === urlmoney1) {
      // mb; rsasig
      const psk = env.PRE_SHARED_KEY_SVC;
      const db = env.DB;
      const pubkeys = rsapubmodulus(env);
      // blindMsg
      return await finalizeOrder(r, psk, pubkeys, db);
    } else if (p[1] === urlmoney2) {
      // mt; token
      const psk = env.PRE_SHARED_KEY_SVC;
      const db = env.DB;
      // msg:rsaSig:sha256(rsaSig):hashedtoken(rand)
      return await generateToken(r, psk, db);
    } else if (p[1] === urlsproxy) {
      // p; proxy metadata
      const clientVCode = p[2];
      if (!clientVCode || clientVCode.length === 0) {
        return r400("p: missing vcode");
      }
      const pkjwk = rsapubkey(env);
      // unparse pkjwk to avoid stringifying it twice
      // undefined keys are left out, null keys are included
      const pk = pkjwk ? JSON.parse(pkjwk) : undefined;

      const minVCodeNeeded = minvcode(env, "paid-features");
      const cansell = greaterThanEqCmp(clientVCode, minVCodeNeeded);
      const clientip = clientIp(r);
      const clientCountry = country(r);
      const clientAsOrg = asorg(r);
      const clientCity = city(r);
      const clientColo = colo(r);
      const clientRegion = region(r);
      const clientPostalCode = postalcode(r);
      const withaddrs = p[3] === "wa" || p[3] === "withaddrs";
      let clientAddrs = [];
      if (cansell && withaddrs) {
        try {
          clientAddrs = await clientaddrs(env.GMAPS_API_KEY, r);
        } catch (ex) {
          clientAddrs = ["unknown:" + ex.message];
        }
      }
      const svcs = svcstatus(env);
      return r200j(
        new d.ResProxy({
          vcode: clientVCode,
          minvcode: minVCodeNeeded,
          cansell: cansell,
          ip: clientip,
          country: clientCountry,
          asorg: clientAsOrg,
          city: clientCity,
          colo: clientColo,
          region: clientRegion,
          postalcode: clientPostalCode,
          addrs: clientAddrs,
          status: svcs,
          pubkey: pk,
        }).json,
      );
    } else {
      log.w(`p: unknown path`, path);
    }
  } catch (ex) {
    log.e(`handle: err`, r.url, ex);
    return r500(ex.message);
  }
  return r302(home);
}

function redirect(req, url, p, home) {
  if (p.length >= 3 && p[2].length > 0) {
    const w = p[2];
    const c = country(req);
    const k = key(w, c);
    if (allLinks.has(k)) {
      // redirect to where tx wants us to
      const redirurl = new URL(allLinks.get(k));
      for (const param of defaultparams(k)) {
        redirurl.searchParams.set(...param);
      }
      for (const paramsin of url.searchParams) {
        redirurl.searchParams.set(...paramsin);
      }
      return r302(redirurl.toString());
    } else {
      // todo: redirect up the parent direct to the same location
      // that is, x.tld/r/w => x.tld/w (handle the redir in this worker!)
      // return r302(`../${w}`);
      // fall-through, for now
    }
  }
  return r302(home);
}

function svcstatus(env) {
  return env.SVC_STATUS || "ok";
}

function minvcode(env, why = "unknown") {
  if (why === "paid-features") {
    // paid features have a minimum vcode of 52
    return env.MIN_VCODE_PAID_FEATURES || "52";
  }
  return env.MIN_VCODE || "30";
}

function key(w, c) {
  if (w.startsWith(ksponsor)) {
    // w is like "sponsor-fr" or "sponsor-us"
    const cc = w.slice(ksponsor.length);
    // use 'cc' if valid, else use 'c'
    c = supportedCountriesSponsor.has(cc) ? cc : c;
    // turn w into plain 'sponsor' with a new 'c'
    w = "sponsor";
  }
  if (w === "sponsor") {
    // use 'c' if valid, else use "us"
    c = supportedCountriesSponsor.has(c) ? c : "us";
    return ksponsor + c;
  }

  if (w.startsWith(krpn)) {
    // w is like "rpn-fr" or "rpn-us"
    const cc = w.slice(krpn.length);
    // use 'cc' if valid, else use 'c'
    c = supportedCountriesRpn.has(cc) ? cc : c;
    // turn w into plain 'rpn' with a new 'c'
    w = "rpn";
  }
  if (w === "rpn") {
    // use 'c' if valid, else use "us"
    c = supportedCountriesRpn.has(c) ? c : "us";
    return krpn + c;
  }

  return w;
}

/**
 * prefilled_email, locale, client_reference_id
 * stripe.com/docs/payment-links/url-parameters
 * @param {string} k
 * @returns {Array<[string, string]>}
 */
function defaultparams(k) {
  if (k.startsWith(ksponsor)) {
    return [
      // email: stripe.com/docs/payments/payment-links#url-parameters
      ["prefilled_email", "anonymous.donor@rethinkdns.com"],
      // locale: stripe.com/docs/api/checkout/sessions/create#create_checkout_session-locale
      ["locale", "auto"],
    ];
  }
  // TODO: cid as prefilled-email
  if (k.startsWith(krpn)) {
    return [
      ["prefilled_email", "anonymous.payee@rethinkdns.com"],
      ["locale", "auto"],
    ];
  }
  return [];
}

/**
 * Get the client address based on latitude and longitude
 * @param {string} apikey
 * @param {Request} req
 * @returns {Promise<string[]>} - Array of addresses or error message.
 */
async function clientaddrs(apikey, req) {
  // get latitude and longitude from request
  if (!req.cf) {
    return ["unknown: not cf"];
  }
  if (!apikey || apikey.length === 0) {
    return ["unknown: no gmaps key"];
  }
  const lat = req.cf.latitude;
  const long = req.cf.longitude;
  if (lat == null || long == null) {
    return ["unknown: no lat/long"];
  }
  // do a reverse geocoding request to get the address
  // developers.google.com/maps/documentation/geocoding/requests-reverse-geocoding
  const streetaddrs = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${long}&key=${apikey}&result_type=street_address&language=en`;
  return fetch(streetaddrs)
    .then((response) => consumejson(response))
    .then((json) => {
      if (
        json != null &&
        json.status === "OK" &&
        json.results &&
        json.results.length > 0
      ) {
        const out = new Array();
        for (const res of json.results) {
          if (res.formatted_address) {
            out.push(res.formatted_address);
          }
        }
        if (out.length > 0) {
          return out;
        }
        return ["unknown: no addresses"];
      }
      return ["unknown: " + json.status];
    })
    .catch((ex) => {
      return ["unknown: " + ex.message];
    });
}

// Returns true if str1 >= str2 in numeric comparison
function greaterThanEqCmp(str1, str2) {
  const n1 = parseInt(str1, 10);
  const n2 = parseInt(str2, 10);
  if (isNaN(n1) || isNaN(n2)) {
    return false; // invalid version code
  }
  return n1 >= n2;
}

/**
 * 90d cryptoperiod:
 * nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf
 * @param {any} env
 * @returns {Uint8Array[]}
 * @throws when rsa-pss pub/priv keys are missing
 */
function rsapubmodulus(env) {
  // see: redir's rsapubkey fn
  const pubprefix = blindRsaPublicKeyPrefix;
  // default key name
  let kpub0 = pubprefix + "A";
  let kpub1 = pubprefix + "B";
  const descend = Object.keys(env)
    .filter((k) => k.startsWith(pubprefix))
    .sort((a, b) => {
      // parse out the unix timestamp from the key name
      const l = parseInt(a.slice(pubprefix.length));
      const r = parseInt(b.slice(pubprefix.length));
      return r - l;
    });
  // two recent keys; descend already contains full key names, do not re-add prefix
  if (descend.length > 0) {
    kpub0 = descend[0];
  }
  if (descend.length > 1) {
    kpub1 = descend[1];
  }
  /*
    {
      alg: "PS384", // RSASSA-PSS using SHA-384 hash algorithm
      e: "AQAB", // exponent​
      ext: true, // extractable
      key_ops: Array [ "verify" ], // ops
  ​    kty: "RSA", // key type
      n: "zON5Gyeeg_...dFJ4IQ" // modulus in base64url
    }
    */
  const pubjwkstr0 = env[kpub0];
  const pubjwkstr1 = env[kpub1];
  if (!pubjwkstr0 || !pubjwkstr1) {
    throw new Error("missing rsa-pss pub keys");
  }

  const pubjwk0 = JSON.parse(pubjwkstr0);
  const pubjwk1 = JSON.parse(pubjwkstr1);
  const pubmod0 = b64AsBytes(pubjwk0.n);
  const pubmod1 = b64AsBytes(pubjwk1.n);

  if (emptyBuf(pubmod0) || emptyBuf(pubmod1)) {
    throw new Error("empty rsa-pss pub keys");
  }
  return [pubmod0, pubmod1];
}

/**
 * @param {any} env
 * @returns {string}
 */
function rsapubkey(env) {
  const pubprefix = blindRsaPublicKeyPrefix;
  // default key name
  let kpub = pubprefix + "A";
  let max = Number.MIN_SAFE_INTEGER;
  for (const k of Object.keys(env)) {
    if (k.startsWith(pubprefix)) {
      const timestamp = k.slice(pubprefix.length);
      // convert timestamp to number
      const t = parseInt(timestamp, 10);
      if (t > max) {
        kpub = pubprefix + timestamp;
        max = t;
      }
    }
  }
  return env[kpub];
}

/**
 * @param {URL} url
 * @returns {boolean} - true if the request must be sent to Windscribe
 */
function mustWsFwd(url) {
  const q = url.searchParams;
  const w = q.get(paramwsfwd);
  return w != null && w.length > 0 && w.startsWith("ws");
}

/**
 * Copies the did token header from an auth response to the business response.
 * Since Response is immutable, a new Response is created with the token header added.
 * @param {Promise<Response>} promisedResponse - the business response
 * @param {Response} authr - the 204 auth response possibly carrying a token header
 * @returns {Promise<Response>}
 */
async function respond(promisedResponse, authr) {
  const token = authr.headers.get(didTokenHeader);
  if (!token) return await promisedResponse;

  const r = await promisedResponse;
  // developers.cloudflare.com/workers/examples/alter-headers/
  const newr = new Response(r.body, r);
  newr.headers.append(didTokenHeader, token);
  return newr;
}

export default {
  async fetch(req, env, ctx) {
    env = d.wrap(env, req);
    return d.ols.run(new d.OuterCtx(env, req, ctx), handle, req, env, ctx);
  },
};
