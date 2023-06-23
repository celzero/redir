/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
import { connect } from "cloudflare:sockets";
import * as auth from "./auth.js";
import Stripe from "stripe";

/** @type Map<string, string> */
const tx = new Map();
const ksponsor = "sponsor-";
const ktranslate = "translate";
const kredirect = "r"; // redirect to dest url
const kpip = "p"; // pipe data to dest domain/
const kstripe = "s"; // stripe checkout webhook

const ctxpip = "per-client-pip-key";
const bypassPipAuth = true; // bypass pip auth for testing

// local currency isn't auto-selected for 'customers choose' payments even if
// prices (of a product) is multi-currency
// stripe.com/docs/products-prices/pricing-models#migrate-from-single-currency-prices-to-multi-currency
// stripe.com/docs/payments/checkout/present-local-currencies#test-currency-presentment
// country codes: www.nationsonline.org/oneworld/country_code_list.htm
// north america
tx.set(ksponsor + "us", "https://donate.stripe.com/aEU00s632gus8hyfYZ"); // USD, US
tx.set(ksponsor + "ca", "https://donate.stripe.com/4gwdRi4YY3HG69q5kL"); // CAD, CA
tx.set(ksponsor + "tt", "https://donate.stripe.com/eVa4gIbnmcecbtK5kR"); // TTD, TT
tx.set(ksponsor + "jm", "https://donate.stripe.com/5kAbJa3UUemkeFWdRo"); // JMD, JM
// ref: european-union.europa.eu/institutions-law-budget/euro/countries-using-euro_en
// euro is the default currency for these 19 eu countries
tx.set(ksponsor + "de", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, DE
tx.set(ksponsor + "fr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, FR
tx.set(ksponsor + "es", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, ES
tx.set(ksponsor + "it", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IT
tx.set(ksponsor + "nl", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, NL
tx.set(ksponsor + "pt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, PT
tx.set(ksponsor + "be", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, BE
tx.set(ksponsor + "at", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, AT
tx.set(ksponsor + "ch", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CH
tx.set(ksponsor + "fi", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, FI
tx.set(ksponsor + "gr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, GR
tx.set(ksponsor + "ie", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IE
tx.set(ksponsor + "lv", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LV
tx.set(ksponsor + "lt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LT
tx.set(ksponsor + "lu", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LU
tx.set(ksponsor + "sk", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SK
tx.set(ksponsor + "si", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SI
tx.set(ksponsor + "ee", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, EE
tx.set(ksponsor + "cy", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CY
tx.set(ksponsor + "mt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, MT
// euro yet to be adopted by these eu countries
tx.set(ksponsor + "se", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SE*
tx.set(ksponsor + "bg", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, BG*
tx.set(ksponsor + "ro", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, RO*
tx.set(ksponsor + "hr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, HR*
tx.set(ksponsor + "pl", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, PL*
tx.set(ksponsor + "cz", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CZ*
tx.set(ksponsor + "hu", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, HU*
// part of the european union, but does not use euro
tx.set(ksponsor + "dk", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, DK*
// european country but not part of the european union
tx.set(ksponsor + "is", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IS*
tx.set(ksponsor + "no", "https://donate.stripe.com/8wM7sUajiemkfK05kV"); // NOK, NO
tx.set(ksponsor + "gb", "https://donate.stripe.com/4gw8wY632a641Ta00a"); // GBP, GB
tx.set(ksponsor + "ru", "https://donate.stripe.com/aEU3cE7764LKfK07sG"); // RUB, RU
tx.set(ksponsor + "tr", "https://donate.stripe.com/28odRidvu920apGeVm"); // TRY, TR
// asean, asia pacific, and oceania
tx.set(ksponsor + "tw", "https://donate.stripe.com/aEU28A2QQ0vu9lC8wI"); // TWD, TW
tx.set(ksponsor + "cn", "https://donate.stripe.com/7sI28A0II9208hy4gp"); // CNY, CN
tx.set(ksponsor + "sg", "https://donate.stripe.com/4gwcNe9fe1zycxOdQX"); // SGD, SG
tx.set(ksponsor + "my", "https://donate.stripe.com/28odRi7766TSfK028n"); // MYR, MY
tx.set(ksponsor + "id", "https://donate.stripe.com/7sI4gIcrq4LK7dueVe"); // IDR, ID
tx.set(ksponsor + "ph", "https://donate.stripe.com/00g00s4YY920fK06oU"); // PHP, PH
tx.set(ksponsor + "jp", "https://donate.stripe.com/dR6eVmcrq5PO55maEX"); // JPY, JP
tx.set(ksponsor + "kr", "https://donate.stripe.com/6oEeVm632dig9lC14s"); // KRW, KR
tx.set(ksponsor + "mn", "https://donate.stripe.com/4gw8wYezygus2XefZt"); // MNT, MN
tx.set(ksponsor + "au", "https://donate.stripe.com/aEU5kM9fe7XWapGcMR"); // AUD, AU
tx.set(ksponsor + "nz", "https://donate.stripe.com/dR6cNe776920cxOdRb"); // NZD, NZ
// mena and south asia
tx.set(ksponsor + "ae", "https://donate.stripe.com/bIYfZq6326TSfK04gk"); // AED, AE
tx.set(ksponsor + "sa", "https://donate.stripe.com/28ofZq6323HG69q14h"); // SAR, SA
tx.set(ksponsor + "qa", "https://donate.stripe.com/7sIeVmdvu9200P6eVb"); // QAR, QA
tx.set(ksponsor + "il", "https://donate.stripe.com/9AQeVmbnmgus0P64gF"); // ILS, IL
tx.set(ksponsor + "eg", "https://donate.stripe.com/14k14waji5PO69qfZy"); // EGP, EG
tx.set(ksponsor + "in", "https://donate.stripe.com/bIYaF6gHGemk55mdQS"); // INR, IN
tx.set(ksponsor + "pk", "https://donate.stripe.com/fZe28A9fe2DCfK04gD"); // PKR, PK
tx.set(ksponsor + "bd", "https://donate.stripe.com/5kA9B2crq1zyapG6oR"); // BDT, BD
tx.set(ksponsor + "np", "https://donate.stripe.com/3cs7sU8baba8cxOeVo"); // NPR, NP
// latin america
tx.set(ksponsor + "br", "https://donate.stripe.com/cN200sezygus0P6eV0"); // BRL, BR
tx.set(ksponsor + "ar", "https://donate.stripe.com/7sIaF66320vu69qcNc"); // ARS, AR
tx.set(ksponsor + "mx", "https://donate.stripe.com/28o3cE4YYgus0P628q"); // MXN, MX
// africa
tx.set(ksponsor + "ke", "https://donate.stripe.com/8wM9B23UUdig0P6eVa"); // KES, KE
tx.set(ksponsor + "ng", "https://donate.stripe.com/00g3cE3UU6TSbtK6oK"); // NGN, NG
tx.set(ksponsor + "za", "https://donate.stripe.com/4gwdRifDCgus8hyeVt"); // ZAR, ZA

tx.set(ktranslate, "https://hosted.weblate.org/engage/rethink-dns-firewall/");

/** @type Set<string> */
const supportedCountries = grabSupportedCountries();

function grabSupportedCountries() {
  const ans = new Set();
  for (const k of tx.keys()) {
    // k is like "sponsor-fr" or "sponsor-us"
    const i = k.indexOf(ksponsor);
    if (i < 0) continue;
    // c is like "fr" or "us"
    const c = k.slice(i + ksponsor.length);
    if (c) ans.add(c);
  }
  return ans;
}

/**
 * @param {Request} r
 * @param {string} home
 * @returns
 */
async function handle(r, env) {
  const home = env.REDIR_CATCHALL;
  try {
    const url = new URL(r.url);
    const path = url.pathname;
    // x.tld/a/b/c/ => ["", "a", "b", "c", ""]
    const p = path.split("/");

    if (p.length < 2) return r302(home);

    if (p[1] === kredirect) {
      return redirect(r, url, p, home);
    } else if (p[1] === kstripe) {
      const whsec = env.STRIPE_WEBHOOK_SECRET;
      const stripeclient = makeStripeClient(env);
      // opt: p[2] === "checkout"
      return stripeCheckout(r, url, stripeclient, whsec);
    } else if (p[1] === kpip) {
      let authok = false;

      if (bypassPipAuth) {
        const h = r.headers.get("x-nile-pip-claim");
        const msg = r.headers.get("x-nile-pip-msg");
        console.warn("bypassing pip auth", "claim?", h, "msg?", msg);
        authok = true;
      } else {
        const sk = auth.keygen(env.SECRET_KEY_MAC_A, ctxpip);
        if (!sk) {
          console.error("no sk");
          return r503();
        }

        const h = r.headers.get("x-nile-pip-claim");
        const msg = r.headers.get("x-nile-pip-msg");
        if (!h || !msg) {
          return r400("no token or msg");
        }

        const [tok, sig, mac] = h.split(":");
        authok = await auth.verifyPipToken(sk, tok, sig, msg, mac);
      }

      if (authok) {
        return pip(r.body, p);
      } else {
        return r400("auth failed");
      }
    } else {
      console.warn("unknown path", path);
    }
  } catch (ex) {
    console.error("handle err", ex);
  }
  return r302(home);
}

/**
 * pipe the data in ingress to dest in p
 * @param {ReadableStream} ingress
 * @param {string[]} p
 * @returns {Response}
 */
function pip(ingress, p) {
  if (p.length < 3) return r400("args missing");
  // ingress may be null for GET or HEAD
  if (ingress == null) return r400("no ingress");

  const dst = p[2];
  if (!dst) return r400("dst missing");

  const dstport = p[3] || "443";
  const proto = p[4] || "tcp";
  const addr = { hostname: dst, port: dstport };
  const opts = { secureTransport: "off", allowHalfOpen: false };
  // sse? community.cloudflare.com/t/184219
  const hdr = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": "-1",
    Connection: "keep-alive",
  };
  try {
    // blog.cloudflare.com/workers-tcp-socket-api-connect-databases
    // github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js
    const egress = connect(addr, opts);
    ingress.pipeTo(egress.writable);
    // .catch(err => console.error("egress err", err))
    // .finally(() => egress.close());
    const canread = egress.readable instanceof ReadableStream;
    console.debug("pip to", addr, proto, "ok?", canread);
    const t = new TextDecoder();
    const c = "";
    for await (const chunk of egress.readable) {
      c += t.decode(chunk);
      console.debug("pip chunk", c, chunk.length);
    }
    return new Response(egress.readable, { headers: hdr });
  } catch (ex) {
    console.error("pip err", ex);
    return r500(ex.message);
  }
}

function redirect(req, url, p, home) {
  if (p.length >= 3 && p[2].length > 0) {
    const w = p[2];
    const c = country(req);
    const k = key(w, c);
    if (tx.has(k)) {
      // redirect to where tx wants us to
      const redirurl = new URL(tx.get(k));
      for (const p of defaultparams(k)) {
        redirurl.searchParams.set(...p);
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

/**
 * @param {Request} req
 * @param {URL} url
 * @param {Stripe} sc
 * @param {string} whsec
 */
async function stripeCheckout(req, url, sc, whsec) {
  // ref: github.com/stripe-samples/stripe-node-cloudflare-worker-template/blob/1cea05be7/src/index.js
  // ref: blog.cloudflare.com/announcing-stripe-support-in-workers/
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  try {
    // throws error if the signature is invalid
    const event = await sc.webhooks.constructEventAsync(
      body,
      sig,
      whsec,
      undefined,
      webCrypto
    );

    // stripe.com/docs/api/events/types
    switch (event.type) {
      case "checkout.session.completed": {
        // stripe.com/docs/api/checkout/sessions/object
        const session = event.data.object;
        createOrder(session);

        // Check if the order is paid (for example, from a card payment)
        //
        // A delayed notification payment will have an `unpaid` status, as
        // you're still waiting for funds to be transferred from the customer's
        // account.
        if (session.payment_status === "paid") {
          fulfillOrder(session);
        }

        break;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        fulfillOrder(session);
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object;
        abandonOrder(session);
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        abandonOrder(session);
        break;
      }
      default:
        console.warn(`stripe: unhandled event ${event.type}`);
    }
  } catch (ignore) {
    console.error("stripe: err", ignore);
  }
  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-type": "application/json" },
  });
}

// Save an order in your database, marked as 'awaiting payment'
function createOrder(session) {
  // todo
}

// stripe.com/docs/payments/checkout/fulfill-orders
function fulfillOrder(session) {
  // todo
}

function abandonOrder(session) {
  // todo
}

function key(w, c) {
  if (w.startsWith(ksponsor)) {
    // w is like "sponsor-fr" or "sponsor-us"
    const cc = w.slice(ksponsor.length);
    // use 'cc' if valid, else use 'c'
    c = supportedCountries.has(cc) ? cc : c;
    // turn w into plain 'sponsor' with a new 'c'
    w = "sponsor";
  }

  if (w === "sponsor") {
    // use 'c' if valid, else use "us"
    c = supportedCountries.has(c) ? c : "us";
    return ksponsor + c;
  }

  return w;
}

/**
 *
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
  return [];
}

// developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties
function country(req) {
  if (req.cf && req.cf.country) {
    return req.cf.country.toLowerCase();
  }
  return "us";
}

// use web crypto
export const webCrypto = Stripe.createSubtleCryptoProvider();

export function makeStripeClient(env) {
  if (!env.STRIPE_API_KEY) {
    throw new Error("STRIPE_API_KEY missing");
  }
  // github.com/stripe-samples/stripe-node-cloudflare-worker-template/commit/1cea05be7fee
  return Stripe(
    env.STRIPE_API_KEY /*{ httpClient: Stripe.createFetchHttpClient() }*/
  );
}

function r503(w) {
  return new Response(w, { status: 503 }); // service unavailable
}

function r500(w) {
  return new Response(w, { status: 500 }); // internal server error
}

function r400(w) {
  return new Response(w, { status: 400 }); // bad request
}

function r302(where) {
  return new Response("Redirecting...", {
    status: 302, // redirect
    headers: { location: where },
  });
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  },
};
