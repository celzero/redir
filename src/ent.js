/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "./buf.js";

export const monthlyProxyProductId = "proxy_monthly_subscription_test";
export const annualProxyProductId = "proxy_annual_subscription_test";
export const stdProductId = "standard.tier";
export const proProductId = "pro.tier";
export const onetimeProductId = "onetime.tier";
export const sponsorProductId = "sponsor.tier";
export const monthlyBasePlanId = "proxy-monthly";
export const yearlyBasePlanId = "proxy-yearly";
export const twoYearlyBasePlanId = "proxy-yearly-2";
export const fiveYearlyBasePlanId = "proxy-yearly-5";
export const sponsorBasePlanId = "sponsor-app";

/** @type {Set<string>} - set of known productIds */
export const knownProducts = new Set([
  monthlyProxyProductId,
  annualProxyProductId,
  stdProductId,
  proProductId,
  onetimeProductId,
]);

/** @type {Set<string>} - set of onetime productIds and planIds */
export const knownOnetimeProductsAndPlans = new Set([
  onetimeProductId,
  twoYearlyBasePlanId,
  fiveYearlyBasePlanId,
]);

/** @type {Map<string, GEntitlement>} - basePlanId => Entitlement */
export const knownBasePlans = new Map();

export class GEntitlement {
  /**
   * @param {string} prod
   * @param {string} base
   * @param {Date} start
   * @param {Date|null} expiry
   */
  constructor(prod, base, start, expiry = null) {
    /** @type {string} */
    this.basePlanId = base || "";
    /** @type {string} */
    this.productId = prod || "";
    /** @type {Date} */
    this.expiry = expiry || new Date(0); // default to epoch
    /** @type {Date} */
    this.start = start || new Date(0);
    /** @type {boolean} */
    this.deferred = expiry == null;
    /** @type {boolean} */
    this.unset = start == null;
  }

  // TODO: can start be null? if check maybeupdaecreds
  // TODO: plan must be "year" or "monthly" for ws calls not "deferred" etc
  static monthly(prod, start, expiry) {
    if (emptyString(prod)) {
      throw new Error("GEntitlement: productId is required for monthly plan");
    }
    return new GEntitlement(prod, monthlyBasePlanId, start, expiry);
  }

  static yearly(prod, start, expiry) {
    if (emptyString(prod)) {
      throw new Error("GEntitlement: productId is required for yearly plan");
    }
    return new GEntitlement(prod, yearlyBasePlanId, start, expiry);
  }

  static twoYearly(prod, start, expiry) {
    if (emptyString(prod)) {
      throw new Error(
        "GEntitlement: productId is required for two-yearly plan",
      );
    }
    return new GEntitlement(prod, twoYearlyBasePlanId, start, expiry);
  }

  static fiveYearly(prod, start, expiry) {
    if (emptyString(prod)) {
      throw new Error(
        "GEntitlement: productId is required for five-yearly plan",
      );
    }
    return new GEntitlement(prod, fiveYearlyBasePlanId, start, expiry);
  }

  /**
   * "Until" is appropriate for use with subscription plans or onetime deferred plans.
   * @param {GEntitlement} o - base product and plan
   * @param {Date|null} s - start date
   * @param {Date|null} t - end date
   * @returns {GEntitlement}
   */
  static until(o, s, t) {
    if (!(o instanceof GEntitlement)) {
      throw new TypeError("GEntitlement.until: o must be a GEntitlement");
    }
    if (!(t instanceof Date)) {
      throw new TypeError("GEntitlement.until: t must be a Date");
    }
    return new GEntitlement(o.productId, o.basePlanId, s, t);
  }

  /**
   * "Since" is appropriate for use with onetime plans, as the "expiry"
   * exclusively depends on the "start" date and the plan duration.
   * For subscriptions, the "expiry" date can be extended or reduced based
   * on user actions, and thus "Until" is more appropriate.
   * @param {GEntitlement} o
   * @param {Date|null} s
   * @returns {GEntitlement}
   */
  static since(o, s) {
    if (!(o instanceof GEntitlement)) {
      throw new TypeError("GEntitlement.since: o must be a GEntitlement");
    }
    if (!(s instanceof Date)) {
      throw new TypeError("GEntitlement.since: s must be a Date");
    }
    const exp = new Date(s);
    if (o.basePlanId === fiveYearlyBasePlanId) {
      exp.setUTCFullYear(exp.getUTCFullYear() + 5);
    } else if (o.basePlanId === twoYearlyBasePlanId) {
      exp.setUTCFullYear(exp.getUTCFullYear() + 2);
    } else if (o.basePlanId === yearlyBasePlanId) {
      exp.setUTCFullYear(exp.getUTCFullYear() + 1);
    } else if (o.basePlanId === monthlyBasePlanId) {
      exp.setUTCMonth(exp.getUTCMonth() + 1);
    } else {
      throw new Error(`GEntitlement.since: unknown basePlanId ${o.basePlanId}`);
    }
    return new GEntitlement(o.productId, o.basePlanId, s, exp);
  }

  // ok returns true if this entitlement is not a placeholder or a deferred entitlement,
  // and has both start and expiry set to a value > unix epoch or (1767187200000
  // 31 Dec 2025, a date after which the paid entitlements should have even started).
  get ok() {
    const minPaymentsDate = 1767187200000;
    if (this.unset) return false;
    if (this.deferred) return false;
    if (this.start == null || this.expiry == null) return false;
    if (!(this.start instanceof Date) || !(this.expiry instanceof Date)) {
      return false;
    }
    if (this.start.getTime() <= minPaymentsDate) return false;
    if (this.expiry.getTime() <= minPaymentsDate) return false;
    return true;
  }

  /**
   * @returns {"month"|"year"|"deferred"|"unknown"} - The subscription period for this entitlement.
   */
  get plan() {
    if (this.deferred) return "deferred";
    if (this.basePlanId.indexOf("monthly") >= 0) return "month";
    if (this.basePlanId.indexOf("yearly") >= 0) return "year";
    if (this.productId.indexOf("month") >= 0) return "month";
    if (this.productId.indexOf("year") >= 0) return "year";
    return "unknown";
    // TODO? throw new Error(`unknown plan ${this.basePlanId} for ${this.productId}`);
  }

  get refundWindowDays() {
    if (this.basePlanId === monthlyBasePlanId) return 3;
    if (this.basePlanId === yearlyBasePlanId) return 7;
    if (this.basePlanId === twoYearlyBasePlanId) return 14;
    if (this.basePlanId === fiveYearlyBasePlanId) return 28;
    return 3;
  }

  get withinRefundWindow() {
    const limitDays = this.refundWindowDays;
    const diffMs = Date.now() - this.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= limitDays;
  }

  get startDate() {
    return this.start.toISOString();
  }

  get expiryDate() {
    return this.expiry.toISOString();
  }

  get json() {
    return {
      productId: this.productId,
      basePlanId: this.basePlanId,
      start: this.start,
      expiry: this.expiry,
      withinRefundWindow: this.withinRefundWindow,
    };
  }

  get str() {
    return `ent(id: ${this.productId}, base: ${this.basePlanId}, start: ${this.start.toISOString()}, expiry: ${this.expiry.toISOString()}, deferred: ${this.deferred}), withinRefundWindow: ${this.withinRefundWindow}`;
  }
}

/**
 * Whether the subscription start/renewal date falls within the 30-day
 * internal refund window.
 * @param {Date} start - subscription start or renewal date
 * @returns {boolean}
 */
export function withinMaxInternalRefundWindow(start) {
  const maxInternalRefundWindowDays = 30;
  const diffMs = Date.now() - start.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= maxInternalRefundWindowDays;
}

knownBasePlans.set(
  monthlyBasePlanId,
  new GEntitlement(stdProductId, monthlyBasePlanId),
);
knownBasePlans.set(
  yearlyBasePlanId,
  new GEntitlement(stdProductId, yearlyBasePlanId),
);
knownBasePlans.set(
  twoYearlyBasePlanId,
  new GEntitlement(onetimeProductId, twoYearlyBasePlanId),
);
knownBasePlans.set(
  fiveYearlyBasePlanId,
  new GEntitlement(onetimeProductId, fiveYearlyBasePlanId),
);
