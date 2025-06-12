/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Stripe from "stripe";
import { emptyBuf, bytcmp, buf2hex, hex2buf } from "./buf.js";
import {
  twentyFiveHoursMs,
  thirtyDaysMs,
  tokenStatusOf,
  errTokenStatus,
  TokenStatus,
} from "./tok.js";
import { importHmacKey, hmacsign, sha256 } from "./webcrypto.js";

// TODO: non-prod spurl endpoint for redir
const spurl = "https://ken.rethinkdns.com/";
const spurlsign = spurl + "sign";
const spurliss = spurl + "iss";

// dashboard.stripe.com/products/prod_O7jipSFxm4qUGy
const proxyStripeProdId = "prod_O7jipSFxm4qUGy";

const headerSvcPsk = "x-nile-svc-psk";
const adelim = ":";

const processingStatus = {
  skip: "skip", // nothing to do
  retry: "retry", // retry later
  success: "success", // success
  unhandled: "unhandled", // unhandled product
};

const paymentStatus = {
  paid: "paid",
  unpaid: "unpaid",
  refunded: "refunded",
  none: "none",
  retry: "retry",
};

class PayStat {
  constructor(f, status) {
    /** @type {number} */
    this.factor = f;
    /** @type {string} */
    this.status = status;
  }

  get ok() {
    return (this.status = paymentStatus.paid);
  }

  get factor() {
    return f;
  }
}

// use web crypto
export const stripeCryptoProvider = Stripe.createSubtleCryptoProvider();

/**
 * @param {Request} req
 * @param {any} db
 * @param {string} apikey
 * @param {string} whsec
 */
export async function stripeCheckout(req, db, apikey, whsec) {
  if (!apikey) {
    throw new Error("STRIPE_API_KEY missing");
  }
  // github.com/stripe/stripe-node/blob/20db17f0802/testProjects/cloudflare-pages/functions/index.js#L7
  // github.com/stripe-samples/stripe-node-cloudflare-worker-template/commit/1cea05be7fee
  const stripe = new Stripe(
    apikey /*{ httpClient: Stripe.createFetchHttpClient() }*/
  );

  // ref: github.com/stripe-samples/stripe-node-cloudflare-worker-template/blob/1cea05be7/src/index.js
  // ref: blog.cloudflare.com/announcing-stripe-support-in-workers
  const whbody = await req.text();
  const whsig = req.headers.get("stripe-signature");
  let out = processingStatus.unhandled;

  try {
    // throws error if the signature is invalid
    const event = await stripe.webhooks.constructEventAsync(
      whbody,
      whsig,
      whsec,
      undefined,
      stripeCryptoProvider
    );

    // TODO: handle refunds: reddit.com/r/stripe/comments/u2ndf0/how_to_listen_to_refunded_event_webhook
    // stackoverflow.com/questions/65420477
    // stripe.com/docs/api/events/types
    // stripe.com/docs/api/checkout/sessions/object
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        out = await createOrFulfillOrder(stripe, session, db);
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        out = await createOrFulfillOrder(stripe, session, db);
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object;
        out = await abandonOrder(stripe, session, db);
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object;
        out = await abandonOrder(stripe, session, db);
        break;
      }
      default:
        console.warn(`stripe: unhandled event ${event.type}`);
    }
  } catch (ignore) {
    console.error("stripe: err", ignore);
  }

  return new Response(JSON.stringify({ received: processok(out) }), {
    headers: { "Content-type": "application/json" },
  });
}

/**
 * Save an order in your database, marked as 'awaiting payment'
 * @param {Stripe} stripe
 * @param {Stripe.Checkout.Session} session
 * @param {any} db
 * @returns {Promise<string>}
 */
async function createOrFulfillOrder(stripe, session, db) {
  const ref = session.client_reference_id;
  if (!ref) {
    const sid = session.id;
    const stx = JSON.stringify(session);
    // TODO: email?
    const rec = await insertLapse(db, sid, stx, "missing-ref");
    console.warn("stripe: missing client_reference_id; noted?", rec.success);
    return processingStatus.skip;
  }
  return fulfillOrder(stripe, session, db);
}

/**
 * stripe.com/docs/payments/checkout/fulfill-orders
 * @param {Stripe} stripe
 * @param {Stripe.Checkout.Session} session
 * @param {any} db
 * @returns {Promise<string>}
 */
async function fulfillOrder(stripe, session, db) {
  // docs.stripe.com/api/financial_connections/sessions/object
  const sid = session.id;
  // ref must be 64 hex chars
  const ref = session.client_reference_id;
  // completed, expired, open
  const sess_stat = session.status;
  // paid, unpaid, no_payment_required
  const pay_stat = session.payment_status;

  // expand and retrieve line items for this session
  // stripe.com/docs/api/checkout/sessions/line_items
  const sessionWithLineItems = await stripe.checkout.sessions.retrieve(sid, {
    expand: ["line_items"],
  });
  const lineItems = sessionWithLineItems.line_items;
  session.line_items = lineItems;
  const stx = JSON.stringify(session);
  if (!lineItems || !lineItems.data || lineItems.data.length <= 0) {
    const rec = await insertLapse(db, sid, stx, "missing-items");
    console.warn("ff: no items", sid, ref, sess_stat, pay_stat, rec.success);
    return processingStatus.skip;
  }

  // get the price to determine the product
  const price = lineItems.data[0].price;
  if (!price) {
    const rec = await insertLapse(db, sid, stx, "missing-price");
    console.warn("ff: no price", sid, ref, sess_stat, pay_stat, rec.success);
    return processingStatus.skip;
  }

  // handle the proxyStripeProdId
  const prodid = price.product;
  if (prodid === proxyStripeProdId) {
    // developers.cloudflare.com/d1/platform/client-api
    // Payees (ref, sess_stat, pay_stat, product TEXT, tx JSON, ts TIMESTAMP);
    const info = await insertPayee(
      db,
      ref,
      sid,
      sess_stat,
      pay_stat,
      prodid,
      stx
    );
    if (info.success) {
      console.debug("ff: db save", info, ref, sid, prodid, sess_stat, pay_stat);
      return processingStatus.success;
    } else {
      console.warn("ff: db err", info, ref, sid, prodid, sess_stat, pay_stat);
      return processingStatus.retry;
    }
  }

  console.warn("ff: unhandled for", prodid);
  return processingStatus.unhandled;
}

/**
 * @param {Stripe} sc
 * @param {Stripe.Checkout.Session} session
 * @param {any} db
 */
async function abandonOrder(sc, session, db) {
  return createOrFulfillOrder(sc, session, db);
}

/**
 * @param {any} db
 * @param {sid} string
 * @param {stx} string
 * @param {why} string
 * @returns {Promise<any>}
 */
async function insertLapse(db, sid, stx, why) {
  // TODO: refund the payment? email?
  // Lapses(id TEXT PRIMARY KEY, tx JSON, reason TEXT, ts DateTime)
  return db
    .query(`INSERT OR REPLACE INTO Lapses (id, tx, reason) values (?1, ?2, ?3)`)
    .bind(sid, stx, why)
    .run();
}

async function insertPayee(db, ref, sid, sess_stat, pay_stat, prodid, stx) {
  return db
    .prepare(
      // caveat: upsert v insert/replace: stackoverflow.com/a/4330694
      // Payees (sid, ref, sess_stat, pay_stat, prod TEXT, tx JSON, ts TIMESTAMP);
      // sid is the stripe session id as primary key
      `INSERT OR REPLACE INTO Payees (id, ref, sess_stat, pay_stat, prod, tx) values (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(sid, ref, sess_stat, pay_stat, prodid, stx)
    .run();
}

/**
 * @param {String} st
 * @returns {boolean}
 */
function processok(st) {
  return st !== processingStatus.retry;
}

/**
 * @param {Request} req
 * @param {string} psk
 * @param {any} db
 * @returns {Promise<Response>}
 */
export async function generateToken(req, psk, db) {
  const msgsighashhthex = await req.text();
  if (!msgsighashhthex) {
    console.warn("gt: missing txt; no-op");
    return r400("missing msg:sig:hash:htok? " + 0);
  }
  const split = msgsighashhthex.split(adelim);
  if (split.length !== 4) {
    console.warn("gt: missing split; no-op");
    return r400("missing msg:sig:hash:htok? " + split.length);
  }

  const msg = hex2buf(split[0]); // unblinded msg
  const sig = hex2buf(split[1]); // unblinded sig
  const sighash0 = hex2buf(split[2]); // sha256(sig)
  const ht = hex2buf(split[3]); // hashed(data-token) to be signed
  if (emptyBuf(msg) || emptyBuf(sig) || emptyBuf(hash) || emptyBuf(ht)) {
    console.warn("gt: missing msg/sig/hash/htok; no-op");
    return r400("missing msg:sig:hash:htok? " + split.length);
  }
  const sighash1 = await sha256(sig);
  const eqsig = bytcmp(sighash1, sighash0);
  if (!eqsig) {
    console.warn("gt: sig (hash) mismatch; no-op");
    return r400("sig mismatch");
  }

  // todo: bind tokenStatusFor and upsertTokenCount in a transaction
  const tokstat = await tokenStatusFor(sighash1, db);
  if (!tokstat.ok) {
    console.warn("gt: stat err", tokstat.err);
    return r400(tokstat.err);
  }

  const expiryMs = twentyFiveHoursMs;
  const cmsgexp = msgsighashhthex + adelim + expiryMs;
  const issres = await fetch(spurliss, {
    body: cmsgexp,
    headers: {
      "Content-type": "application/text",
      [headerSvcPsk]: psk,
    },
  });
  if (!issres.ok) {
    console.warn("gt: iss err", issres.status, issres.statusText);
  } else {
    // TODO: handle when not ok
    const dbok = await upsertTokenCount(sighash1, db);
    console.log("gt: db upsert?", dbok, "for", sighash1);
  }
  return issres;
}

/**
 * @param {Request} req
 * @param {string} psk
 * @param {Uint8Array[]} pubmods
 * @param {any} db
 * @returns {Promise<Response>}
 */
export async function finalizeOrder(req, psk, pubmods, db) {
  const blindMsgHex = await req.text();
  if (!blindMsgHex) {
    console.warn("fo: missing txt; no-op");
    return r400("missing blindmsg");
  }
  const blindMsg = hex2buf(blindMsgHex);

  let paystatus = paymentStatus.unpaid;
  for (const n of pubmods) {
    const st = await paymentStatusFor(blindMsg, n, db);
    paystatus = st.status;
    // nb: paymentStatus.retry isn't handled any differently
    if (paystatus !== paymentStatus.none) {
      break;
    } // else: retry with the previous pubkey
  }

  if (paystatus === paymentStatus.paid) {
    return fetch(spurlsign, {
      body: blindMsgHex, // must send hex; see serverless-proxy
      headers: {
        "Content-type": "application/text",
        [headerSvcPsk]: psk,
      },
    });
  } else {
    return r401(paystatus);
  }
}

/**
 * @param {Uint8Array} sig
 * @param {any} db
 * @returns {Promise<TokenStatus>}
 */
async function tokenStatusFor(sig, db) {
  const sighex = buf2hex(sig);
  // developers.cloudflare.com/d1/platform/client-api#reusing-prepared-statements
  // Issues (ref VARCHAR(64) PRIMARY KEY, n INTEGER, ts TIMESTAMP)
  const rec = await db
    .prepare(`SELECT * FROM Issues WHERE ref = ?1`)
    .bind(sighex)
    .all();
  if (!rec.success) {
    console.warn("tok: db err", rec);
    return errTokenStatus("dberr");
  }
  // there should either be 0 or 1 records
  if (rec.results && rec.results.length > 0) {
    const c = rec.results[0].n;
    const ts = rec.results[i].ts;
    const factor = 1; // determineFactor(rec);
    const stat = tokenStatusOf(c, factor, ts);
    const cok = stat.countok;
    const tsok = stat.tsok;
    // TODO: delete the expired record from the db
    console.info("pay: c?", c, cok, "ts?", ts, tsok, "for", sighex);
    return stat;
  }
  console.info("pay: new issue!", sighex);
  const nowstr = new Date().toISOString();
  return tokenStatusOf(0, 1, nowstr);
}

/*function determineFactor(rec) {
  let factor = 1, c = 0, ts = 0;
  // rec.results must be ascending by ts
    for (let i = 0; i < rec.results.length; i++) {
      // ts & results.ts are in iso8601 format
      const tmin = ts; // base ts
      const trec = new Date(rec.results[i].ts).getTime();
      const overlaps = tmin + thirtyDaysMs * factor > trec;
      if (overlaps) {
        ts = tmin; // keep the base ts
        factor += 1; // 1 for each overlap in the last 30 days
        c = rec.results[i].n; // all records have the same count n
      } else {
        ts = trec; // reset the base ts
        factor = 1; // reset the factor in case of a gap
        c = rec.results[i].n; // reset the count
      }
    }
    return factor;
}*/

/**
 * @param {Uint8Array} blindmsg
 * @param {Uint8Array} hmackeyraw
 * @param {any} db
 * @returns {Promise<PayStat>}
 */
async function paymentStatusFor(blindmsg, hmackeyraw, db) {
  // calculate hmac-sha256(blindmsg, pubkey)
  const hk = await importHmacKey(hmackeyraw);
  const mac = await hmacsign(hk, blindmsg);
  const machex = buf2hex(mac);
  // developers.cloudflare.com/d1/platform/client-api#reusing-prepared-statements
  // Payees (sid VARCHAR(128) PRIMARY KEY, ref VARCHAR(64) INDEX, sess_stat TEXT, pay_stat TEXT, prod TEXT, tx JSON, ts TIMESTAMP);
  const rec = await db
    .prepare(`SELECT pay_stat FROM Payees WHERE ref = ?1 ORDER BY ts DESC`)
    .bind(machex)
    .all();
  if (!rec.success) {
    console.warn("pay: db err", rec);
    return paymentStatus.retry;
  }
  // there should either be 0 or 1 records
  if (rec.results && rec.results.length > 0) {
    const ts = rec.results[0];
    const factor = 1; // determineFactorPayment(rec);
    const tsok = ts + thirtyDaysMs * factor > Date.now();
    return tsok
      ? new PayStat(factor, paymentStatus.paid)
      : new PayStat(0, paymentStatus.unpaid);
  }
  console.info("pay: no record for", machex, rec);
  return new PayStat(0, paymentStatus.none);
}

/*function determineFactorPayment(rec) {
// rec.results must be ascending by ts
for (let i = 0; i < rec.results.length; i++) {
  const pay_stat = rec.results[i].pay_stat;
  const payok = paymentOK(pay_stat);
  console.info("pay: paid?", payok, pay_stat, "for", machex);
  if (!payok) {
    continue;
  }
  // ts & results.ts are in iso8601 format
  const tmin = ts; // base ts
  const trec = new Date(rec.results[i].ts).getTime();
  const overlaps = tmin + thirtyDaysMs * factor > trec;
  if (overlaps) {
    ts = tmin; // keep the base ts
    factor += 1; // 1 for each overlap in the last 30 days
  } else {
    ts = trec; // reset the base ts
    factor = 1; // reset the factor in case of a gap
  }
      }
}*/

async function upsertTokenCount(sig, db) {
  const sighex = buf2hex(sig);
  // Issues (ref TEXT PRIMARY KEY, n INT DEFAULT 1, ts DateTime DEFAULT CURRENT_TIMESTAMP)
  const rec = await db
    .prepare(
      `INSERT INTO Issues (ref) values (?1) ON CONFLICT(ref) DO UPDATE SET n = Issues.n + 1`
    )
    .bind(sighex)
    .run();
  if (!rec.success) {
    console.warn("tok: db err", rec);
    return false;
  }
  return true;
}

/**
 * @param {string} dbstat
 */
function paymentOK(dbstat) {
  // dbstat from stripe.payment_status (paid, unpaid, no_payment_required)
  return dbstat === "paid" || dbstat === "no_payment_required";
}
