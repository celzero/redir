/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/** @type {Map<string, string>} */
const lx = new Map();

export const ktranslate = "translate"; 
export const ksponsor = "sponsor-";
export const krpn = "rpn-";

// local currency isn't auto-selected for 'customers choose' payments even if
// prices (of a product) is multi-currency
// stripe.com/docs/products-prices/pricing-models#migrate-from-single-currency-prices-to-multi-currency
// stripe.com/docs/payments/checkout/present-local-currencies#test-currency-presentment
// country codes: www.nationsonline.org/oneworld/country_code_list.htm
// north america
lx.set(ksponsor + "us", "https://donate.stripe.com/aEU00s632gus8hyfYZ"); // USD, US
lx.set(ksponsor + "ca", "https://donate.stripe.com/4gwdRi4YY3HG69q5kL"); // CAD, CA
lx.set(ksponsor + "tt", "https://donate.stripe.com/eVa4gIbnmcecbtK5kR"); // TTD, TT
lx.set(ksponsor + "jm", "https://donate.stripe.com/5kAbJa3UUemkeFWdRo"); // JMD, JM
// ref: european-union.europa.eu/institutions-law-budget/euro/countries-using-euro_en
// euro is the default currency for these 19 eu countries
lx.set(ksponsor + "de", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, DE
lx.set(ksponsor + "fr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, FR
lx.set(ksponsor + "es", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, ES
lx.set(ksponsor + "it", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IT
lx.set(ksponsor + "nl", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, NL
lx.set(ksponsor + "pt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, PT
lx.set(ksponsor + "be", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, BE
lx.set(ksponsor + "at", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, AT
lx.set(ksponsor + "ch", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CH
lx.set(ksponsor + "fi", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, FI
lx.set(ksponsor + "gr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, GR
lx.set(ksponsor + "ie", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IE
lx.set(ksponsor + "lv", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LV
lx.set(ksponsor + "lt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LT
lx.set(ksponsor + "lu", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, LU
lx.set(ksponsor + "sk", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SK
lx.set(ksponsor + "si", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SI
lx.set(ksponsor + "ee", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, EE
lx.set(ksponsor + "cy", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CY
lx.set(ksponsor + "mt", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, MT
// euro yet to be adopted by these eu countries
lx.set(ksponsor + "se", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, SE*
lx.set(ksponsor + "bg", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, BG*
lx.set(ksponsor + "ro", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, RO*
lx.set(ksponsor + "hr", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, HR*
lx.set(ksponsor + "pl", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, PL*
lx.set(ksponsor + "cz", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, CZ*
lx.set(ksponsor + "hu", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, HU*
// part of the european union, but does not use euro
lx.set(ksponsor + "dk", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, DK*
// european country but not part of the european union
lx.set(ksponsor + "is", "https://donate.stripe.com/5kAaF61MM9207dubIQ"); // EUR, IS*
lx.set(ksponsor + "no", "https://donate.stripe.com/8wM7sUajiemkfK05kV"); // NOK, NO
lx.set(ksponsor + "gb", "https://donate.stripe.com/4gw8wY632a641Ta00a"); // GBP, GB
lx.set(ksponsor + "ru", "https://donate.stripe.com/aEU3cE7764LKfK07sG"); // RUB, RU
lx.set(ksponsor + "tr", "https://donate.stripe.com/28odRidvu920apGeVm"); // TRY, TR
// asean, asia pacific, and oceania
lx.set(ksponsor + "tw", "https://donate.stripe.com/aEU28A2QQ0vu9lC8wI"); // TWD, TW
lx.set(ksponsor + "cn", "https://donate.stripe.com/7sI28A0II9208hy4gp"); // CNY, CN
lx.set(ksponsor + "sg", "https://donate.stripe.com/4gwcNe9fe1zycxOdQX"); // SGD, SG
lx.set(ksponsor + "my", "https://donate.stripe.com/28odRi7766TSfK028n"); // MYR, MY
lx.set(ksponsor + "id", "https://donate.stripe.com/7sI4gIcrq4LK7dueVe"); // IDR, ID
lx.set(ksponsor + "ph", "https://donate.stripe.com/00g00s4YY920fK06oU"); // PHP, PH
lx.set(ksponsor + "jp", "https://donate.stripe.com/dR6eVmcrq5PO55maEX"); // JPY, JP
lx.set(ksponsor + "kr", "https://donate.stripe.com/6oEeVm632dig9lC14s"); // KRW, KR
lx.set(ksponsor + "mn", "https://donate.stripe.com/4gw8wYezygus2XefZt"); // MNT, MN
lx.set(ksponsor + "au", "https://donate.stripe.com/aEU5kM9fe7XWapGcMR"); // AUD, AU
lx.set(ksponsor + "nz", "https://donate.stripe.com/dR6cNe776920cxOdRb"); // NZD, NZ
// mena and south asia
lx.set(ksponsor + "ae", "https://donate.stripe.com/bIYfZq6326TSfK04gk"); // AED, AE
lx.set(ksponsor + "sa", "https://donate.stripe.com/28ofZq6323HG69q14h"); // SAR, SA
lx.set(ksponsor + "qa", "https://donate.stripe.com/7sIeVmdvu9200P6eVb"); // QAR, QA
lx.set(ksponsor + "il", "https://donate.stripe.com/9AQeVmbnmgus0P64gF"); // ILS, IL
lx.set(ksponsor + "eg", "https://donate.stripe.com/14k14waji5PO69qfZy"); // EGP, EG
lx.set(ksponsor + "in", "https://donate.stripe.com/bIYaF6gHGemk55mdQS"); // INR, IN
lx.set(ksponsor + "pk", "https://donate.stripe.com/fZe28A9fe2DCfK04gD"); // PKR, PK
lx.set(ksponsor + "bd", "https://donate.stripe.com/5kA9B2crq1zyapG6oR"); // BDT, BD
lx.set(ksponsor + "np", "https://donate.stripe.com/3cs7sU8baba8cxOeVo"); // NPR, NP
// latin america
lx.set(ksponsor + "br", "https://donate.stripe.com/cN200sezygus0P6eV0"); // BRL, BR
lx.set(ksponsor + "ar", "https://donate.stripe.com/7sIaF66320vu69qcNc"); // ARS, AR
lx.set(ksponsor + "mx", "https://donate.stripe.com/28o3cE4YYgus0P628q"); // MXN, MX
// africa
lx.set(ksponsor + "ke", "https://donate.stripe.com/8wM9B23UUdig0P6eVa"); // KES, KE
lx.set(ksponsor + "ng", "https://donate.stripe.com/00g3cE3UU6TSbtK6oK"); // NGN, NG
lx.set(ksponsor + "za", "https://donate.stripe.com/4gwdRifDCgus8hyeVt"); // ZAR, ZA

lx.set(ktranslate, "https://hosted.weblate.org/engage/rethink-dns-firewall/");

// north america
lx.set(krpn + "us", "https://buy.stripe.com/fZe6oQ1MMdigeFW00C"); // USD, US, 1
lx.set(krpn + "ca", "https://buy.stripe.com/28o4gIaji1zy7du4gV"); // CAD, CA, 1.4
lx.set(krpn + "tt", "https://buy.stripe.com/28o7sU4YYa6441i7t8"); // TTD, TT, 7
lx.set(krpn + "jm", "https://buy.stripe.com/8wMeVm776ba8btKaFl"); // JMD, JM, 160
// eu
lx.set(krpn + "de", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, DE, 0.9
lx.set(krpn + "fr", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, FR
lx.set(krpn + "es", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, ES
lx.set(krpn + "it", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, IT
lx.set(krpn + "nl", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, NL
lx.set(krpn + "pt", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, PT
lx.set(krpn + "be", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, BE
lx.set(krpn + "at", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, AT
lx.set(krpn + "ch", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, CH
lx.set(krpn + "fi", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, FI
lx.set(krpn + "gr", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, GR
lx.set(krpn + "ie", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, IE
lx.set(krpn + "lv", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, LV
lx.set(krpn + "lt", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, LT
lx.set(krpn + "lu", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, LU
lx.set(krpn + "sk", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, SK
lx.set(krpn + "si", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, SI
lx.set(krpn + "ee", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, EE
lx.set(krpn + "cy", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, CY
lx.set(krpn + "mt", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, MT
lx.set(krpn + "hr", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, HR
lx.set(krpn + "lu", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, LU
lx.set(krpn + "pl", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, PL
// euro yet to be adopted by these eu countries
lx.set(krpn + "se", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, SE*
lx.set(krpn + "bg", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, BG*
lx.set(krpn + "ro", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, RO*
lx.set(krpn + "hr", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, HR*
lx.set(krpn + "pl", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, PL*
lx.set(krpn + "cz", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, CZ*
lx.set(krpn + "hu", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, HU*
// part of the european union, but does not use euro
lx.set(krpn + "dk", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, DK*
// european country but not part of the european union
lx.set(krpn + "is", "https://buy.stripe.com/eVaaF68ba7XWgO44gY"); // EUR, IS*
lx.set(krpn + "no", "https://buy.stripe.com/fZedRiaji7XW0P69Bj"); // NOK, NO, 11
lx.set(krpn + "gb", "https://buy.stripe.com/6oE4gI0II7XW2Xe14O"); // GBP, GB, 0.8
lx.set(krpn + "ru", "https://buy.stripe.com/28o28A1MM5PO0P614P"); // RUB, RU, 90
lx.set(krpn + "tr", "https://buy.stripe.com/9AQeVm0II4LKfK000M"); // TRY, TR, 26
lx.set(krpn + "ua", "https://buy.stripe.com/8wM14w632dig7ducO2"); // UAH, UA, 40
lx.set(krpn + "bg", "https://buy.stripe.com/5kA9B27767XWgO48xT"); // BGN, BG, 2
lx.set(krpn + "by", "https://buy.stripe.com/dR6bJa0IIfqo0P64hE"); // BYN, BY, 2.5
lx.set(krpn + "rs", "https://buy.stripe.com/8wMbJa8bacec41i4hN"); // RSD, RS, 110
lx.set(krpn + "md", "https://buy.stripe.com/14kbJa9fe2DCfK03dN"); // MDL, MD, 20
lx.set(krpn + "ba", "https://buy.stripe.com/8wMcNegHGfqo69q5lW"); // BAM, BA, 2
// asean, asia pacific, and oceania
lx.set(krpn + "tw", "https://buy.stripe.com/aEU14w3UU2DCeFW4h3"); // TWD, TW, 32
lx.set(krpn + "cn", "https://buy.stripe.com/7sIeVmaji7XW69q6pc"); // CNY, CN, 7
lx.set(krpn + "sg", "https://buy.stripe.com/7sIaF62QQ1zyeFW14T"); // SGD, SG, 1.4
lx.set(krpn + "my", "https://buy.stripe.com/fZe5kM0IIa64btKcNC"); // MYR, MY, 4.7
lx.set(krpn + "id", "https://buy.stripe.com/5kA00saji3HG55mfZP"); // IDR, ID, 15,200
lx.set(krpn + "ph", "https://buy.stripe.com/28o00sfDCfqoapG4h8"); // PHP, PH, 56
lx.set(krpn + "jp", "https://buy.stripe.com/bIY3cEfDCemk7du4h9"); // JPY, JP, 142
lx.set(krpn + "kr", "https://buy.stripe.com/5kA3cEdvu2DCapGeVO"); // KRW, KR, 1,300
lx.set(krpn + "mn", "https://buy.stripe.com/fZeeVmajia64gO4aFz"); // MNT, MN, 3,500
lx.set(krpn + "au", "https://buy.stripe.com/bIY00s8ba92041i294"); // AUD, AU, 1.5
lx.set(krpn + "nz", "https://buy.stripe.com/6oE28Aaji4LKbtK7tp"); // NZD, NZ, 1.6
lx.set(krpn + "mm", "https://buy.stripe.com/00g9B2bnm7XW41i9BT"); // MMK, MM, 2,100
lx.set(krpn + "th", "https://buy.stripe.com/7sI28AfDCdig7du15p"); // THB, TH, 35
lx.set(krpn + "kh", "https://buy.stripe.com/aEUaF6ezy92055m29z"); // KHR, KH, 4,200
// mena and south asia
lx.set(krpn + "ae", "https://buy.stripe.com/7sIfZq4YYa648hy9By"); // AED, AE, 4
lx.set(krpn + "sa", "https://buy.stripe.com/dR63cEbnm2DC41i3dc"); // SAR, SA, 4
lx.set(krpn + "qa", "https://buy.stripe.com/4gw5kMbnm2DC69q9Bz"); // QAR, QA, 4
lx.set(krpn + "il", "https://buy.stripe.com/5kAbJa0II0vuapGdRR"); // ILS, IL, 4
lx.set(krpn + "eg", "https://buy.stripe.com/9AQaF6ezydig1Ta9BC"); // EGP, EG, 30
lx.set(krpn + "in", "https://buy.stripe.com/8wM5kM632digbtK8xa"); // INR, IN, 85
lx.set(krpn + "pk", "https://buy.stripe.com/8wM7sUcrq1zyeFW9BD"); // PKR, PK, 300
lx.set(krpn + "bd", "https://buy.stripe.com/9AQaF64YY2DCfK0dRU"); // BDT, BD, 110
lx.set(krpn + "np", "https://buy.stripe.com/aEU7sU0IIcec0P6015"); // NPR, NP, 130
lx.set(krpn + "ma", "https://buy.stripe.com/8wMcNegHG3HG41ieW6"); // MAD, MA, 10
lx.set(krpn + "dz", "https://buy.stripe.com/bIY8wY4YYba8cxO3dt"); // DZD, DZ, 130
lx.set(krpn + "af", "https://buy.stripe.com/eVa5kM632fqo9lC3dr"); // AFN, AF, 90
lx.set(krpn + "lk", "https://buy.stripe.com/00g8wYfDC1zy55m4hK"); // LKR, LK, 320
lx.set(krpn + "ye", "https://buy.stripe.com/14kbJadvu5PO1Ta9C5"); // YER, YE, 250
lx.set(krpn + "lb", "https://buy.stripe.com/aEUeVmaji1zy2Xe8y5"); // LBP, LB, 15,000
// central asia
lx.set(krpn + "uz", "https://buy.stripe.com/8wMeVmezy1zy69qbK0"); // UZS, UZ, 12,000
lx.set(krpn + "kz", "https://buy.stripe.com/aEU6oQ2QQ1zycxO01m"); // KZT, KZ, 450
lx.set(krpn + "az", "https://buy.stripe.com/5kA6oQcrq0vucxO4hG"); // AZN, AZ, 1.80
lx.set(krpn + "ge", "https://buy.stripe.com/dR68wYaji2DC2Xe29A"); // GEL, GE, 2.70
// latin america
lx.set(krpn + "br", "https://buy.stripe.com/14keVmfDC6TSapG3di"); // BRL, BR, 5
lx.set(krpn + "ar", "https://buy.stripe.com/28o28AgHGemk2XeaFL"); // ARS, AR, 265
lx.set(krpn + "mx", "https://buy.stripe.com/4gwbJagHGa6455m3dk"); // MXN, MX, 17
lx.set(krpn + "pe", "https://buy.stripe.com/7sIbJa3UUcecgO4eWe"); // PEN, PE, 4
lx.set(krpn + "co", "https://buy.stripe.com/28o00s0II4LK9lC5lJ"); // COP, CO, 4,100
lx.set(krpn + "cl", "https://buy.stripe.com/6oE7sU8badig2Xe9C3"); // CLP, CL, 810
lx.set(krpn + "bo", "https://buy.stripe.com/7sIcNeezya64btK5lQ"); // BOB, BO, 7
lx.set(krpn + "uy", "https://buy.stripe.com/fZe5kM8bafqo7du15H"); // UYU, UY, 40
// central america
lx.set(krpn + "gt", "https://buy.stripe.com/8wM00sezy4LKfK0g0w"); // GTQ, GT, 8
lx.set(krpn + "do", "https://buy.stripe.com/7sI28A6326TSeFWg0b"); // DOP, DO, 60
// africa
lx.set(krpn + "ke", "https://buy.stripe.com/dR63cE3UU920gO4bJR"); // KES, KE, 140
lx.set(krpn + "ng", "https://buy.stripe.com/14k4gIgHGguscxOg08"); // NGN, NG, 800
lx.set(krpn + "za", "https://buy.stripe.com/cN2dRigHGceceFW5lv"); // ZAR, ZA, 20
lx.set(krpn + "tz", "https://buy.stripe.com/dR6cNe9fe3HGbtKcO0"); // TZS, TZ, 2,500
lx.set(krpn + "ug", "https://buy.stripe.com/cN26oQ2QQdigcxOaGe"); // UGX, UG, 3,700

export function grabSupportedCountries(key) {
  const ans = new Set();
  for (const k of lx.keys()) {
    // k is like "key-cc"; ex: "sponsor-fr" or "rpn-us"
    const i = k.indexOf(key);
    if (i < 0) continue;
    // c is like "fr" or "us"
    const c = k.slice(i + key.length);
    if (c) ans.add(c);
  }
  return ans;
}

export function grabLinks() {
  return lx;
}