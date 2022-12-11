/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/** @type Map<string, string> */
const tx = new Map();
const ksponsor = "sponsor-";
// local currency isn't auto-selected for 'customers choose' payments even if
// prices (of a product) is multi-currency
// stripe.com/docs/products-prices/pricing-models#migrate-from-single-currency-prices-to-multi-currency
// stripe.com/docs/payments/checkout/present-local-currencies#test-currency-presentment
// country codes: https://www.nationsonline.org/oneworld/country_code_list.htm
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

tx.set("translate", "https://hosted.weblate.org/engage/rethink-dns-firewall/");

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

function redirect(r, home) {
    console.log(r.url, r.cf);
  try {
      const url = new URL(r.url);
      const path = url.pathname;
      // x.tld/a/b/c/ => ["", "a", "b", "c", ""]
      const p = path.split("/");
      if (p.length >= 3 && p[2].length > 0 && p[2].length <= 10) {
          const w = p[2];
          const c = country(r);
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
  } catch(ex) {
      console.error(ex);
  }
  return r302(home);
}

function key(w, c) {
  if (w === "sponsor") {
    if (!supportedCountries.has(c)) c = "us";
    return `${w}-${c}`;
  }
  return w;
}

/**
 *
 * @param {string} k
 * @returns {Array<[string, string]>}
 */
function defaultparams(k) {
  if (k.startsWith("sponsor")) {
    return [
      // email: stripe.com/docs/payments/payment-links#url-parameters
      ["prefilled_email", "anonymous.donor%40rethinkdns.com"],
      // locale: stripe.com/docs/api/checkout/sessions/create#create_checkout_session-locale
      ["locale", "auto"]
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

function r302(where) {
    return new Response("Redirecting...", {
        status: 302, // redirect
        headers: {location: where},
    });
}

export default {
    async fetch(request, env, ctx) {
        return redirect(request, env.REDIR_CATCHALL);
    },
};

