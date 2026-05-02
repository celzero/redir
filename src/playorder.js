/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { emptyString } from "./buf.js";
import { accountIdentifiersImmutable, als, ExecCtx, go, obsToken } from "./d.js";
import { GCreds, getGoogleAuthToken } from "./gauth.js";
import * as glog from "./log.js";
import { mincidlength } from "./reg.js";
import {
  activeOnly as activeOnlyOf,
  cid as cidOf,
  consumejson,
  force as forceOf,
  isTest,
  purchaseToken as purchaseTokenOf,
  r200play,
  r200t,
  r400play as r400j,
  r403play as r403j,
  r405play as r405j,
  r409play as r409j,
  r500play as r500j,
  sku as skuOf,
  tot as totOf,
} from "./req.js";
import * as dbx from "./sql/dbx.js";
import { crandHex, obfuscate } from "./webcrypto.js";
import {
  creds,
  deleteWsEntitlement,
  getOrGenWsEntitlement,
  WSEntitlement,
} from "./wsent.js";

// r200j wraps the payload in PlayOk before serialising (playorder-specific behaviour)
const r200j = r200play;

/** @type {boolean} - whether to attach entitlement with IAP acknowledgment */
const attachEntitlementToAck = false;

// setup: developers.google.com/android-publisher/getting_started
// developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
const androidscope = ["https://www.googleapis.com/auth/androidpublisher"];
const packageName = "com.celzero.bravedns";

// subscriptionId isn't required since May 21, 2025
// ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge
// but: github.com/googleapis/google-api-go-client/blob/971a6f113/androidpublisher/v3/androidpublisher-gen.go#L19539
const iap1 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/tokens/`;
const iap2 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptionsv2/tokens/`;
// ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/get
const iap3 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/productsv2/tokens/`;
// ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/acknowledge
const iap4 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/`;
const iap5 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/orders/`;
const tokpath = "/tokens/";
const acksuffix = ":acknowledge";
// see: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/revoke
// and: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/revoke
// revoke = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/`;
const revokesuffix = ":revoke";
// see: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/cancel
const cancelsuffix = ":cancel";
const refundsuffix = ":refund";
// see: developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume
const consumesuffix = ":consume";
// see: developers.google.com/android-publisher/api-ref/rest/v3/orders/refund
const revokeparam = "revoke=true";
const cancelparam = "revoke=false";

const monthlyProxyProductId = "proxy_monthly_subscription_test";
const annualProxyProductId = "proxy_annual_subscription_test";
const stdProductId = "standard.tier";
const proProductId = "pro.tier";
const onetimeProductId = "onetime.tier";
const sponsorProductId = "sponsor.tier";
const monthlyBasePlanId = "proxy-monthly";
const yearlyBasePlanId = "proxy-yearly";
const twoYearlyBasePlanId = "proxy-yearly-2";
const fiveYearlyBasePlanId = "proxy-yearly-5";
const sponsorBasePlanId = "sponsor-app";

const log = new glog.Log("playorder");

/** @type {Set<string>} - set of known productIds */
const knownProducts = new Set([
  monthlyProxyProductId,
  annualProxyProductId,
  stdProductId,
  proProductId,
  onetimeProductId,
]);

/** @type {Set<string>} - set of onetime productIds and planIds */
const knownOnetimeProductsAndPlans = new Set([
  onetimeProductId,
  twoYearlyBasePlanId,
  fiveYearlyBasePlanId,
]);

/** @type {Map<string, GEntitlement>} - basePlanId => Entitlement */
const knownBasePlans = new Map();

/**
 * Memoization cache for Google tokens.
 * @type {Map<string, GCreds>}
 */
const gtokenCache = new Map();

class GEntitlement {
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

/*
{
  "message": {
    "attributes": {
      "key": "value"
    },
    "data": "eyAidmVyc2lvbiI6IHN0cmluZywgInBhY2thZ2VOYW1lIjogc3RyaW5nLCAiZXZlbnRUaW1lTWlsbGlzIjogbG9uZywgIm9uZVRpbWVQcm9kdWN0Tm90aWZpY2F0aW9uIjogT25lVGltZVByb2R1Y3ROb3RpZmljYXRpb24sICJzdWJzY3JpcHRpb25Ob3RpZmljYXRpb24iOiBTdWJzY3JpcHRpb25Ob3RpZmljYXRpb24sICJ0ZXN0Tm90aWZpY2F0aW9uIjogVGVzdE5vdGlmaWNhdGlvbiB9",
    "messageId": "136969346945"
  },
  "subscription": "projects/myproject/subscriptions/mysubscription"
}*/
class Rtdn {
  constructor(json) {
    if (
      json == null ||
      typeof json !== "object" ||
      json.message == null ||
      typeof json.message !== "object"
    ) {
      throw new Error("Invalid RTDN JSON");
    }
    /**
     * @type {Object} - arb kv.
     */
    this.attributes = json.message.attributes || {};
    /**
     * @type {JSON} - base64 encoded JSON string.
     */
    this.data = json.message.data ? JSON.parse(atob(json.message.data)) : {};
    /**
     * @type {string} - The identifier of this notification.
     */
    this.messageId = json.message.messageId || "";
    /**
     * @type {string} - The subscription project ID for the notification.
     */
    this.subscription = json.subscription || "";
  }

  get notification() {
    return this.data ? new DeveloperNotification(this.data) : null;
  }
}

/**
 * @see https://developer.android.com/google/play/billing/rtdn-reference
 * ```
 * {
 *   "version": string,
 *   "packageName": string,
 *   "eventTimeMillis": long,
 *   "oneTimeProductNotification": OneTimeProductNotification,
 *   "subscriptionNotification": SubscriptionNotification,
 *   "voidedPurchaseNotification": VoidedPurchaseNotification,
 *   "testNotification": TestNotification
 * }
 * ```
 */
class DeveloperNotification {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The version of this notification. Initially, this is "1.0". This version is distinct from other version fields.
     */
    this.version = json.version || "";
    /**
     * @type {string} - The package name of the app that this notification is for.
     */
    this.packageName = json.packageName || "";
    /**
     * @type {number} - The time at which this notification was sent, in milliseconds since the epoch.
     */
    this.eventTimeMillis = json.eventTimeMillis || -1;

    const onetime = json.oneTimeProductNotification || null;
    const sub = json.subscriptionNotification || null;
    const voided = json.voidedPurchaseNotification || null;
    const test = json.testNotification || null;

    /**
     * @type {OneTimeProductNotification} - The notification for one-time product purchases.
     */
    this.onetime =
      onetime != null ? new OneTimeProductNotification(onetime) : null;
    /**
     * @type {SubscriptionNotification} - The notification for subscription purchases.
     */
    this.sub = sub != null ? new SubscriptionNotification(sub) : null;
    /**
     * @type {VoidedPurchaseNotification} - The notification for voided purchases.
     */
    this.void = voided != null ? new VoidedPurchaseNotification(voided) : null;
    /**
     * @type {TestNotification} - The notification for test purchases.
     */
    this.test = test != null ? new TestNotification(test) : null;
  }
}

/**
 * @see https://developer.android.com/google/play/billing/rtdn-reference#one-time
 * ```
 * {
 *   "version": string,
 *   "notificationType": int,
 *   "purchaseToken": string,
 *   "sku": string
 * }
 * ```
 */
class OneTimeProductNotification {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The version of this notification. Initially, this is "1.0". This version is distinct from other version fields.
     */
    this.version = json.version || "";
    /**
     * @type {number} - The notificationType for a one-time product can have the following values:
     * (1) ONE_TIME_PRODUCT_PURCHASED - A new one-time product was purchased.
     * (2) ONE_TIME_PRODUCT_CANCELED - A one-time product was refunded.
     * @see https://developer.android.com/google/play/billing/rtdn-reference#notification_type
     */
    this.notificationType = json.notificationType || -1;
    /**
     * @type {string} - The purchase token of the one-time product.
     */
    this.purchaseToken = json.purchaseToken || "";
    /**
     * @type {string} - The SKU of the one-time product.
     */
    this.sku = json.sku || "";
  }
}

/**
 * @see https://developer.android.com/google/play/billing/rtdn-reference#sub
 * ```
 * {
 *   "version": string,
 *   "notificationType": int,
 *   "purchaseToken": string
 * }
 * ```
 */
class SubscriptionNotification {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The version of this notification. Initially, this is "1.0". This version is distinct from other version fields.
     */
    this.version = json.version || "";
    /**
     * @type {number} - The notificationType for a subscription can have the following values:
     * (1) SUBSCRIPTION_RECOVERED - A subscription was recovered from account hold.
     * (2) SUBSCRIPTION_RENEWED - An active subscription was renewed.
     * (3) SUBSCRIPTION_CANCELED - A subscription was either voluntarily or involuntarily cancelled. For voluntary cancellation, sent when the user cancels.
     * (4) SUBSCRIPTION_PURCHASED - A new subscription was purchased.
     * (5) SUBSCRIPTION_ON_HOLD - A subscription has entered account hold (if enabled).
     * (6) SUBSCRIPTION_IN_GRACE_PERIOD - A subscription has entered grace period (if enabled).
     * (7) SUBSCRIPTION_RESTARTED - User has restored their subscription from Play > Account > Subscriptions. The subscription was cancelled but had not expired yet when the user restores. For more information, see Restorations.
     * (8) SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (DEPRECATED) - A subscription price change has successfully been confirmed by the user.
     * (9) SUBSCRIPTION_DEFERRED - A subscription's recurrence time has been extended.
     * (10) SUBSCRIPTION_PAUSED - A subscription has been paused.
     * (11) SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED - A subscription pause schedule has been changed.
     * (12) SUBSCRIPTION_REVOKED - A subscription has been revoked from the user before the expiration time.
     * (13) SUBSCRIPTION_EXPIRED - A subscription has expired.
     * (20) SUBSCRIPTION_PENDING_PURCHASE_CANCELED - A pending transaction of a subscription has been cancelled.
     * (19) SUBSCRIPTION_PRICE_CHANGE_UPDATED - A subscription item's price change details are updated.
     * @see https://developer.android.com/google/play/billing/rtdn-reference#notification_type
     */
    this.notificationType = json.notificationType || -1;
    /**
     * @type {string} - The purchase token of the subscription.
     */
    this.purchaseToken = json.purchaseToken || "";
  }
}

/**
 * @see https://developer.android.com/google/play/billing/rtdn-reference#voided-purchase
 *
 * ```
 *   {
 *     "purchaseToken":"PURCHASE_TOKEN",
 *     "orderId":"GS.0000-0000-0000",
 *     "productType":1,
 *     "refundType":1
 *   }
 * ```
 */
class VoidedPurchaseNotification {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The purchase token of the voided purchase.
     */
    this.purchaseToken = json.purchaseToken || "";
    /**
     * @type {string} - The order ID of the voided purchase.
     */
    this.orderId = json.orderId || "";
    /**
     * @type {number} - The product type of the voided purchase.
     * (1) PRODUCT_TYPE_SUBSCRIPTION for subscription
     * (2) PRODUCT_TYPE_ONE_TIME for one-time product.
     */
    this.productType = json.productType || -1;
    /**
     * @type {number} - The refund type of the voided purchase.
     * (1) REFUND_TYPE_FULL_REFUND for full refund
     * (2) REFUND_TYPE_QUANTITY_BASED_PARTIAL_REFUND for partial refund.
     */
    this.refundType = json.refundType || -1;
  }
}

/**
 * @see https://developer.android.com/google/play/billing/rtdn-reference#test
 * ```
 * {
 *  "version": string
 * }
 * ```
 */
class TestNotification {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The version of this notification. Initially, this is "1.0". This version is distinct from other version fields.
     */
    this.version = json.version || "";
  }
}

/**
 * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
 * ```
 * {
  "kind": "androidpublisher#subscriptionPurchaseV2",
  "regionCode": "US",
  "startTime": "2024-01-15T10:00:00Z",
  "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
  "latestOrderId": "GPA.3345-1234-5678-90123",
  "linkedPurchaseToken": null,
  "pausedStateContext": null,
  "canceledStateContext": null,
  "testPurchase": null,
  "acknowledgementState": "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  "externalAccountIdentifiers": {
    "externalAccountId": "user-ext-acc-88765",
    "obfuscatedExternalAccountId": "obfuscated-acc-id-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    "obfuscatedExternalProfileId": "obfuscated-prof-id-9876543210zYxWvUtSrQpOnMlKjIhGfEdCbA"
  },
  "subscribeWithGoogleInfo": {
    "profileId": "109876543210987654321",
    "profileName": "Alex Smith",
    "emailAddress": "alex.smith.swg@example.com",
    "givenName": "Alex",
    "familyName": "Smith"
  },
  "lineItems": [
    {
      "productId": "premium_monthly_v2",
      "expiryTime": "2025-01-15T10:00:00Z",
      "autoRenewingPlan": {
        "autoRenewEnabled": true,
        "recurringPrice": {
          "units": "12",
          "nanos": 990000000,
          "currencyCode": "USD"
        },
        "priceChangeDetails": null,
        "installmentDetails": null
      },
      "prepaidPlan": null,
      "offerDetails": {
        "basePlanId": "premium-monthly",
        "offerId": "intro-offer-7day",
        "offerTags": [
          "initial_discount",
          "seasonal_promo"
        ]
      },
      "deferredItemReplacement": null,
      "signupPromotion": null
    }
  ]
 }

 example:
    {
      "kind": "androidpublisher#subscriptionPurchaseV2",
      "regionCode": "IN",
      "startTime": "2025-07-10T12:42:00.327Z",
      "subscriptionState": "SUBSCRIPTION_STATE_EXPIRED",
      "latestOrderId": "GPA.1111-1111-1111-11111",
      "linkedPurchaseToken": null,
      "pausedStateContext": null,
      "canceledStateContext": {
        "userInitiatedCancellation": {
          "cancelSurveyResult": null,
          "cancelTime": "2025-07-10T12:42:16.075Z"
        },
        "systemInitiatedCancellation": null,
        "developerInitiatedCancellation": null,
        "replacementCancellation": null
      },
      "testPurchase": {},
      "acknowledgementState": "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      "externalAccountIdentifiers": {
        "externalAccountId": "",
        "obfuscatedExternalAccountId": "deadbeef",
        "obfuscatedExternalProfileId": ""
      },
      "subscribeWithGoogleInfo": null,
      "lineItems": [
        {
          "productId": "standard.tier",
          "expiryTime": "2025-07-10T12:46:59.421Z",
          "latestSuccessfulOrderId": "GPA.1111-1111-1111-11111",
          "autoRenewingPlan": {
            "autoRenewEnabled": false,
            "recurringPrice": {
              "currencyCode": "INR",
              "units": "210",
              "nanos": -1
            },
            "priceChangeDetails": null,
            "installmentDetails": null
          },
          "prepaidPlan": null,
          "offerDetails": {
            "offerTags": [],
            "basePlanId": "proxy-monthly",
            "offerId": ""
          },
          "deferredItemReplacement": null,
          "signupPromotion": null
        }
      ]
    }
 * ```
 */
class SubscriptionPurchaseV2 {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The kind of resource this is, in this case androidpublisher#subscriptionPurchaseV2.
     */
    this.kind = json.kind || "";
    /**
     * @type {string} - The region code of the subscription.
     */
    this.regionCode = json.regionCode || "";
    /**
     * @type {string} - The start time of the subscription in RFC3339 format.
     */
    this.startTime = json.startTime || "";
    /**
     * @type {string} - The state of the subscription. One of:
     * SUBSCRIPTION_STATE_UNSPECIFIED,
     * SUBSCRIPTION_STATE_PENDING,
     * SUBSCRIPTION_STATE_ACTIVE,
     * SUBSCRIPTION_STATE_PAUSED,
     * SUBSCRIPTION_STATE_IN_GRACE_PERIOD,
     * SUBSCRIPTION_STATE_ON_HOLD,
     * SUBSCRIPTION_STATE_CANCELED,
     * SUBSCRIPTION_STATE_EXPIRED,
     * SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED.
     * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#subscriptionstate
     */
    this.subscriptionState = json.subscriptionState || "";
    /**
     * @type {string} - The latest order ID for the subscription.
     * @deprecated - Use lineItems.latest_successful_order_id instead
     */
    this.latestOrderId = json.latestOrderId || "";
    /**
     * @type {string} - Linked purchase token, if any.
     */
    this.linkedPurchaseToken = json.linkedPurchaseToken || null;
    /**
     * @type {PausedStateContext} - Paused state context, if any.
     */
    this.pausedStateContext = json.pausedStateContext
      ? new PausedStateContext(json.pausedStateContext)
      : null;
    /**
     * @type {CanceledStateContext} - Cancelled state context, if any.
     */
    this.canceledStateContext = json.canceledStateContext
      ? new CanceledStateContext(json.canceledStateContext)
      : null;
    /**
     * @type {TestPurchase} - Test purchase information, if any.
     */
    this.testPurchase = json.testPurchase
      ? new TestPurchase(json.testPurchase)
      : null;
    /**
     * @type {string} - Acknowledgement state of the subscription.
     * 1 ACKNOWLEDGEMENT_STATE_UNSPECIFIED
     * 2 ACKNOWLEDGEMENT_STATE_PENDING
     * 2 ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED
     */
    this.acknowledgementState = json.acknowledgementState || "";
    /**
     * @type {ExternalAccountIdentifiers} - External account identifiers, if any.
     */
    this.externalAccountIdentifiers = json.externalAccountIdentifiers
      ? new ExternalAccountIdentifiers(json.externalAccountIdentifiers)
      : null;
    /**
     * @type {SubscribeWithGoogleInfo} - Subscribe with Google information, if any.
     */
    this.subscribeWithGoogleInfo = json.subscribeWithGoogleInfo
      ? new SubscribeWithGoogleInfo(json.subscribeWithGoogleInfo)
      : null;
    /**
     * @type {Array<SubscriptionLineItem>} - Line items in the subscription.
     */
    this.lineItems = Array.isArray(json.lineItems)
      ? json.lineItems.map((item) => new SubscriptionLineItem(item))
      : [];
  }
}

/**
 * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/get
 * ```
    {
      "kind": "androidpublisher#productPurchase",
      "purchaseTimeMillis": "1700000000000",
      "purchaseState": 0,
      "consumptionState": 0,
      "developerPayload": "string",
      "orderId": "GPA.1234-5678-9012-34567",
      "purchaseType": 0,
      "acknowledgementState": 1,
      "productId": "sku",
      "purchaseToken": "token",
      "quantity": 1,
      "refundableQuantity": 1,
      "regionCode": "US",
      "obfuscatedExternalAccountId": "string",
      "obfuscatedExternalProfileId": "string"
    }
 * ```
 */
class ProductPurchaseV1 {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The kind of resource this is, in this case androidpublisher#productPurchase.
     */
    this.kind = json.kind || "";
    /**
     * @type {number} - Purchase time in milliseconds since epoch.
     */
    this.purchaseTimeMillis = json.purchaseTimeMillis
      ? Number(json.purchaseTimeMillis)
      : -1;
    /**
     * @type {number} - Purchase state: 0 Purchased, 1 Canceled, 2 Pending.
     */
    this.purchaseState = json.purchaseState ?? -1;
    /**
     * @type {number} - Consumption state: 0 Yet to be consumed, 1 Consumed.
     */
    this.consumptionState = json.consumptionState ?? -1;
    /**
     * @type {string} - Developer payload, if any.
     */
    this.developerPayload = json.developerPayload || "";
    /**
     * @type {string} - Order ID, if any.
     */
    this.orderId = json.orderId || "";
    /**
     * @type {number} - Purchase type, if any (may not be set); 0 Test, 1 Promo, 2 Rewarded.
     */
    this.purchaseType = json.purchaseType ?? -1;
    /**
     * @type {number} - Acknowledgement state; 0 Yet to be acknowledged, 1 Acknowledged.
     */
    this.acknowledgementState = json.acknowledgementState ?? -1;
    /**
     * @type {string} - Product ID (may not be present)
     */
    this.purchaseToken = json.purchaseToken || "";
    /**
     * @type {string} - Product type (sku).
     */
    this.productId = json.productId || "";
    /**
     * @type {number} - Default from Google RTDN is 1 (may be 0).
     * multi-quantity purchases are only supported for consumable one-time sku
     * @see developer.android.com/google/play/billing/integrate#mq
     */
    this.quantity = json.quantity ?? 0;
    /**
     * @type {string} - Obfuscated external account ID, if any.
     */
    this.obfuscatedExternalAccountId = json.obfuscatedExternalAccountId || "";
    /**
     * @type {string} - Obfuscated external profile ID, if any.
     */
    this.obfuscatedExternalProfileId = json.obfuscatedExternalProfileId || "";
    /**
     * @type {string} - Region code, if any.
     */
    this.regionCode = json.regionCode || "";
    /**
     * @type {number} - Quantity that hasn't been refunded, if any.
     */
    this.refundableQuantity = json.refundableQuantity ?? 0;
  }
}

/**
  * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/getproductpurchasev2
  * ```
    {
      "productLineItem": [
        {
          object (ProductLineItem)
        }
      ],
      "kind": "androidpublisher#productPurchaseV2",
      "purchaseStateContext": {
        object (PurchaseStateContext)
      },
      "testPurchaseContext": {
        object (TestPurchaseContext)
      },
      "orderId": "GPA.1234-5678-9012-34567",
      "obfuscatedExternalAccountId": "string",
      "obfuscatedExternalProfileId": "string",
      "regionCode": "US",
      "purchaseCompletionTime": "2024-01-15T10:00:00Z",
      "acknowledgementState": "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
    }

    example:
    {
      "productLineItem": [
        {
          "productId": "onetime.tier",
          "productOfferDetails": {
            "offerTags": [],
            "offerId": "",
            "purchaseOptionId": "proxy-yearly-2",
            "rentOfferDetails": null,
            "offerToken": "",
            "quantity": 1,
            "refundableQuantity": 1,
            "consumptionState": "CONSUMPTION_STATE_YET_TO_BE_CONSUMED"
          }
        }
      ],
      "kind": "androidpublisher#productPurchaseV2",
      "purchaseStateContext": {
        "purchaseState": "PURCHASED"
      },
      "testPurchaseContext": {
        "fopType": "TEST"
      },
      "orderId": "GPA.3306-8815-9212-00335",
      "obfuscatedExternalAccountId": "deadbeef",
      "obfuscatedExternalProfileId": "",
      "regionCode": "IN",
      "purchaseCompletionTime": "2026-02-28T20:24:19.404Z",
      "acknowledgementState": "ACKNOWLEDGEMENT_STATE_PENDING"
    }
 * ```
 */
class ProductPurchaseV2 {
  constructor(json) {
    json = json || {};
    /** @type {Array<ProductLineItem>} */
    this.productLineItem = Array.isArray(json.productLineItem)
      ? json.productLineItem.map((item) => new ProductLineItem(item))
      : [];
    /** @type {string} */
    this.kind = json.kind || "";
    /** @type {PurchaseStateContext|null} */
    this.purchaseStateContext = json.purchaseStateContext
      ? new PurchaseStateContext(json.purchaseStateContext)
      : null;
    /** @type {TestPurchaseContext|null} */
    this.testPurchaseContext = json.testPurchaseContext
      ? new TestPurchaseContext(json.testPurchaseContext)
      : null;
    /** @type {string} */
    this.orderId = json.orderId || "";
    /** @type {string} */
    this.obfuscatedExternalAccountId = json.obfuscatedExternalAccountId || "";
    /** @type {string} */
    this.obfuscatedExternalProfileId = json.obfuscatedExternalProfileId || "";
    /** @type {string} */
    this.regionCode = json.regionCode || "";
    /**
     * @type {string} - Uses RFC3339, where generated output will always be Z-normalized and
     * use 0, 3, 6 or 9 fractional digits. Offsets other than "Z" are also accepted.
     * Examples: "2014-10-02T15:01:23Z", "2014-10-02T15:01:23.045123456Z" or "2014-10-02T15:01:23+05:30".
     * The time when the purchase was successful. Not present until the payment is complete. */
    this.purchaseCompletionTime = json.purchaseCompletionTime || "";
    /** @type {"ACKNOWLEDGEMENT_STATE_UNSPECIFIED"|"ACKNOWLEDGEMENT_STATE_PENDING"|"ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"} */
    this.acknowledgementState = json.acknowledgementState || "";
  }
}

class ProductLineItem {
  constructor(json) {
    json = json || {};
    /** @type {string} */
    this.productId = json.productId || "";
    /** @type {ProductOfferDetails|null} */
    this.productOfferDetails = json.productOfferDetails
      ? new ProductOfferDetails(json.productOfferDetails)
      : null;
  }
}

class ProductOfferDetails {
  constructor(json) {
    json = json || {};
    /** @type {Array<string>} */
    this.offerTags = Array.isArray(json.offerTags) ? json.offerTags : [];
    /** @type {string} */
    this.offerId = json.offerId || "";
    /** @type {string} */
    this.purchaseOptionId = json.purchaseOptionId || "";
    /** @type {RentOfferDetails|null} */
    this.rentOfferDetails = json.rentOfferDetails
      ? new RentOfferDetails(json.rentOfferDetails)
      : null;
    /** @type {string} */
    this.offerToken = json.offerToken || "";
    /**
     * @type {number} - set to at least 1 for valid purchases
     * multi-quantity purchases are only supported for consumable one-time sku
     * @see developer.android.com/google/play/billing/integrate#mq
     */
    this.quantity = json.quantity ?? -1;
    /** @type {number} */
    this.refundableQuantity = json.refundableQuantity ?? -1;
    /** @type {"CONSUMPTION_STATE_UNSPECIFIED" | "CONSUMPTION_STATE_CONSUMED" | "CONSUMPTION_STATE_YET_TO_BE_CONSUMED" } */
    this.consumptionState = json.consumptionState || "";
  }
}

class RentOfferDetails {
  constructor(json) {
    json = json || {};
  }
}

class PurchaseStateContext {
  constructor(json) {
    json = json || {};
    /** @type {"PURCHASE_STATE_UNSPECIFIED"|"PURCHASED"|"CANCELLED"|"PENDING"} */
    this.purchaseState = json.purchaseState || "";
  }
}

class TestPurchaseContext {
  constructor(json) {
    json = json || {};
    /** @type {"FOP_TYPE_UNSPECIFIED"|"TEST"} */
    this.fopType = json.fopType || "";
  }
}

/**
 * Union field cancellation_reason can be only one of the following:
 * ```
 *  {
 *  "userInitiatedCancellation": {
 *    object (UserInitiatedCancellation)
 *  },
 *  "systemInitiatedCancellation": {
 *    object (SystemInitiatedCancellation)
 *  },
 *  "developerInitiatedCancellation": {
 *    object (DeveloperInitiatedCancellation)
 *  },
 *  "replacementCancellation": {
 *    object (ReplacementCancellation)
 *  }
 *  }
 * ```
 */
class CanceledStateContext {
  constructor(json) {
    json = json || {};
    /**
     * @type {UserInitiatedCancellation} - User initiated cancellation, if any.
     */
    this.userInitiatedCancellation = json.userInitiatedCancellation
      ? new UserInitiatedCancellation(json.userInitiatedCancellation)
      : null;
    /**
     * @type {SystemInitiatedCancellation} - System initiated cancellation, if any.
     */
    this.systemInitiatedCancellation = json.systemInitiatedCancellation
      ? new SystemInitiatedCancellation(json.systemInitiatedCancellation)
      : null;
    /**
     * @type {DeveloperInitiatedCancellation} - Developer initiated cancellation, if any.
     */
    this.developerInitiatedCancellation = json.developerInitiatedCancellation
      ? new DeveloperInitiatedCancellation(json.developerInitiatedCancellation)
      : null;
    /**
     * @type {ReplacementCancellation} - Replacement cancellation, if any.
     */
    this.replacementCancellation = json.replacementCancellation
      ? new ReplacementCancellation(json.replacementCancellation)
      : null;
  }
}

/**
 * ```json
 * {
 *   "cancelSurveyResult": {
 *     object (CancelSurveyResult)
 *   },
 *   "cancelTime": string
 * }
 * ```
 */
class UserInitiatedCancellation {
  constructor(json) {
    json = json || {};
    /**
     * @type {CancelSurveyResult} - The result of the cancellation survey, if any.
     */
    this.cancelSurveyResult = json.cancelSurveyResult
      ? new CancelSurveyResult(json.cancelSurveyResult)
      : null;
    /**
     * @type {string} - The time at which the cancellation was initiated, in RFC3339 format.
     */
    this.cancelTime = json.cancelTime || "";
  }
}

/**
 * ```json
 * {
 *   "reason": enum (CancelSurveyReason),
 *   "reasonUserInput": string
 * }
 * ```
 */
class CancelSurveyResult {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The result of the cancellation survey, among:
     * 1 CANCEL_SURVEY_REASON_UNSPECIFIED
     * 2 CANCEL_SURVEY_REASON_NOT_ENOUGH_USAGE
     * 3 CANCEL_SURVEY_REASON_TECHNICAL_ISSUES
     * 4 CANCEL_SURVEY_REASON_COST_RELATED
     * 5 CANCEL_SURVEY_REASON_FOUND_BETTER_APP
     * 6 CANCEL_SURVEY_REASON_OTHERS
     */
    this.cancelSurveyResult = json.reason || "";
    /**
     * @type {string} - The comment provided by the user, if any.
     */
    this.comment = json.reasonUserInput || "";
  }
}

class SystemInitiatedCancellation {
  constructor(json) {
    json = json || {};
  }
}
class DeveloperInitiatedCancellation {
  constructor(json) {
    json = json || {};
  }
}
class ReplacementCancellation {
  constructor(json) {
    json = json || {};
  }
}

class TestPurchase {
  constructor(json) {
    json = json || {};
  }
}

/**
 * @see https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#PausedStateContext
 * ```json
 * {
 *   "autoResumeTime": string
 * }
 * ```
 */
class PausedStateContext {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The time at which the subscription will be automatically resumed, in RFC3339 format.
     */
    this.autoResumeTime = json.autoResumeTime || "";
  }
}

/**
 * ```json
 * {
 *   "externalAccountId": string,
 *   "obfuscatedExternalAccountId": string,
 *   "obfuscatedExternalProfileId": string
 * }
 * ```
 */
class ExternalAccountIdentifiers {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The external account ID, if any.
     */
    this.externalAccountId = json.externalAccountId || "";
    /**
     * @type {string} - The obfuscated external account ID, if any.
     */
    this.obfuscatedExternalAccountId = json.obfuscatedExternalAccountId || "";
    /**
     * @type {string} - The obfuscated external profile ID, if any.
     */
    this.obfuscatedExternalProfileId = json.obfuscatedExternalProfileId || "";
  }
}

/**
 * ```json
 * {
 *   "profileId": string,
 *   "profileName": string,
 *   "emailAddress": string,
 *   "givenName": string,
 *   "familyName": string
 * }
 * ```
 */
class SubscribeWithGoogleInfo {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The profile ID of the user.
     */
    this.profileId = json.profileId || "";
    /**
     * @type {string} - The profile name of the user.
     */
    this.profileName = json.profileName || "";
    /**
     * @type {string} - The email address of the user.
     */
    this.emailAddress = json.emailAddress || "";
    /**
     * @type {string} - The given name of the user.
     */
    this.givenName = json.givenName || "";
    /**
     * @type {string} - The family name of the user.
     */
    this.familyName = json.familyName || "";
  }
}

/**
 * ```js
 * {
 *   "productId": string,
 *   "expiryTime": string,
 *   "latestSuccessfulOrderId": string,
 *
 *   // Union field plan_type can be only one of the following:
 * "autoRenewingPlan": {
 *  object (AutoRenewingPlan)
 * },
 * "prepaidPlan": {
 *   object (PrepaidPlan)
 * }
 * // End of list of possible types for union field plan_type.
 * "offerDetails": {
 *   object (OfferDetails)
 * },
 *
 *  // Union field deferred_item_change can be only one of the following:
 * "deferredItemReplacement": {
 *   object (DeferredItemReplacement)
 * }
 * // End of list of possible types for union field deferred_item_change.
 * "signupPromotion": {
 *   object (SignupPromotion)
 * }
 *}
 * ```
 */
class SubscriptionLineItem {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The product ID of the subscription line item.
     */
    this.productId = json.productId || "";
    /**
     * @type {string|null} - The expiry time of the subscription line item in RFC3339 format.
     */
    this.expiryTime = emptyString(json.expiryTime) ? null : json.expiryTime;
    /**
     * @type {string} - The latest successful order ID for the subscription line item.
     */
    this.latestSuccessfulOrderId = json.latestSuccessfulOrderId || "";
    /**
     * @type {AutoRenewingPlan} - The auto-renewing plan for the subscription line item, if any.
     */
    this.autoRenewingPlan = json.autoRenewingPlan
      ? new AutoRenewingPlan(json.autoRenewingPlan)
      : null;
    /**
     * @type {PrepaidPlan} - The prepaid plan for the subscription line item, if any.
     */
    this.prepaidPlan = json.prepaidPlan
      ? new PrepaidPlan(json.prepaidPlan)
      : null;
    /**
     * @type {OfferDetails} - The offer details for the subscription line item, if any.
     */
    this.offerDetails = json.offerDetails
      ? new OfferDetails(json.offerDetails)
      : null;
    /**
     * @type {DeferredItemReplacement} - The deferred item replacement for the subscription line item, if any.
     */
    this.deferredItemReplacement = json.deferredItemReplacement
      ? new DeferredItemReplacement(json.deferredItemReplacement)
      : null;
    /**
     * @type {SignupPromotion} - The signup promotion for the subscription line item, if any.
     */
    this.signupPromotion = json.signupPromotion
      ? new SignupPromotion(json.signupPromotion)
      : null;
  }
}

/**
 * ```json
 * {
 *   "autoRenewEnabled": boolean,
 *   "recurringPrice": {
 *     object (Money)
 *   },
 *   "priceChangeDetails": {
 *     object (SubscriptionItemPriceChangeDetails)
 *   },
 *   "installmentDetails": {
 *     object (InstallmentPlan)
 *   }
 * }
 * ```
 */
class AutoRenewingPlan {
  constructor(json) {
    json = json || {};
    /**
     * @type {boolean} - Whether the auto-renewing plan is enabled.
     */
    this.autoRenewEnabled = json.autoRenewEnabled || false;
    /**
     * @type {Money} - The recurring price of the auto-renewing plan.
     */
    this.recurringPrice = json.recurringPrice
      ? new Money(json.recurringPrice)
      : null;
    /**
     * @type {SubscriptionItemPriceChangeDetails} - The price change details for the subscription item, if any.
     */
    this.priceChangeDetails = json.priceChangeDetails
      ? new SubscriptionItemPriceChangeDetails(json.priceChangeDetails)
      : null;
    /**
     * @type {InstallmentPlan} - The installment details for the subscription item, if any.
     */
    this.installmentDetails = json.installmentDetails
      ? new InstallmentPlan(json.installmentDetails)
      : null;
  }
}

/**
 * ```json
 * {
 *  "newPrice": {
 *    object (Money)
 *  },
 *  "priceChangeMode": enum (PriceChangeMode),
 *  "priceChangeState": enum (PriceChangeState),
 *  "expectedNewPriceChargeTime": string
 * }
 * ```
 */
class SubscriptionItemPriceChangeDetails {
  constructor(json) {
    json = json || {};
    /**
     * @type {Money} - The new price for the subscription item.
     */
    this.newPrice = json.newPrice ? new Money(json.newPrice) : null;
    /**
     * @type {string} - The price change mode for the subscription item.
     * One of:
     * 1 PRICE_CHANGE_MODE_UNSPECIFIED
     * 2 PRICE_DECREASE
     * 3 PRICE_INCREASE
     * 4 OPT_OUT_PRICE_INCREASE
     */
    this.priceChangeMode = json.priceChangeMode || "";
    /**
     * @type {string} - The price change state for the subscription item.
     * One of:
     * 1 PRICE_CHANGE_STATE_UNSPECIFIED
     * 2 OUTSTANDING
     * 3 CONFIRMED
     * 4 APPLIED
     * 5 CANCELED
     */
    this.priceChangeState = json.priceChangeState || "";
    /**
     * @type {string} - The expected new price charge time for the subscription item in RFC3339 format.
     */
    this.expectedNewPriceChargeTime = json.expectedNewPriceChargeTime || "";
  }
}

/**
 * @see https://developers.google.com/android-publisher/api-ref/rest/v3/Money
 * ```json
 * {
 * "currencyCode": string,
 * "units": string,
 *  "nanos": integer
 * }
 * ```
 */
class Money {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The currency code of the money amount, e.g., "USD".
     */
    this.currencyCode = json.currencyCode || "";
    /**
     * @type {string} - The amount in whole units, e.g., "12" for $12.00.
     */
    this.units = json.units || "";
    /**
     * @type {number} - The amount in nanos, e.g., 990000000 for $12.99.
     */
    this.nanos = json.nanos ?? -1;
  }
}

/**
 * ```json
 * {
 *   "initialCommittedPaymentsCount": integer,
 *   "subsequentCommittedPaymentsCount": integer,
 *   "remainingCommittedPaymentsCount": integer,
 *   "pendingCancellation": {
 *     object (PendingCancellation)
 *   }
 * }
 * ```
 */
class InstallmentPlan {
  constructor(json) {
    json = json || {};
    /**
     * @type {number} - The number of initial committed payments.
     */
    this.initialCommittedPaymentsCount =
      json.initialCommittedPaymentsCount || -1;
    /**
     * @type {number} - The number of subsequent committed payments.
     */
    this.subsequentCommittedPaymentsCount =
      json.subsequentCommittedPaymentsCount || -1;
    /**
     * @type {number} - The number of remaining committed payments.
     */
    this.remainingCommittedPaymentsCount =
      json.remainingCommittedPaymentsCount || -1;
    /**
     * @type {PendingCancellation} - Pending cancellation details, if any.
     */
    this.pendingCancellation = json.pendingCancellation
      ? new PendingCancellation(json.pendingCancellation)
      : null;
  }
}

class PendingCancellation {
  constructor(json) {
    json = json || {};
  }
}

/**
 * ```json
 * {
 *   "allowExtendAfterTime": string
 * }
 * ```
 */
class PrepaidPlan {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The time after which the prepaid plan can be extended, in RFC3339 format.
     */
    this.allowExtendAfterTime = json.allowExtendAfterTime || "";
  }
}

/**
 * ```json
 * {
 *   "offerTags": [
 *     string
 *   ],
 *   "basePlanId": string,
 *   "offerId": string
 * }
 * ```
 */
class OfferDetails {
  constructor(json) {
    json = json || {};
    /**
     * @type {Array<string>} - The offer tags associated with the offer.
     */
    this.offerTags = Array.isArray(json.offerTags) ? json.offerTags : [];
    /**
     * @type {string} - The base plan ID for the offer.
     */
    this.basePlanId = json.basePlanId || "";
    /**
     * @type {string} - The offer ID for the offer.
     */
    this.offerId = json.offerId || "";
  }
}

/**
 * ```json
 * {
 *   "productId": string
 * }
 * ```
 */
class DeferredItemReplacement {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The product ID of the deferred item replacement.
     */
    this.productId = json.productId || "";
  }
}

/**
 * ```json
 * {
 * // Union field promotion_type can be only one of the following:
 * "oneTimeCode": {
 *   object (OneTimeCode)
 * },
 * "vanityCode": {
 *   object (VanityCode)
 * }
 * // End of list of possible types for union field promotion_type.
 * }
 * ```
 */
class SignupPromotion {
  constructor(json) {
    json = json || {};
    /**
     * @type {OneTimeCode} - One-time code promotion, if any.
     */
    this.oneTimeCode = json.oneTimeCode
      ? new OneTimeCode(json.oneTimeCode)
      : null;
    /**
     * @type {VanityCode} - Vanity code promotion, if any.
     */
    this.vanityCode = json.vanityCode ? new VanityCode(json.vanityCode) : null;
  }
}

class OneTimeCode {
  constructor(json) {
    json = json || {};
  }
}

/**
 * ```json
 * {
 *   "promotionCode": string
 * }
 * ```
 */
class VanityCode {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The promotion code for the vanity code.
     */
    this.promotionCode = json.promotionCode || "";
  }
}

/**
 * @param {any} env
 * @param {Request} r
 * @returns {Promise<Response>}
 * @throws {Error} if the notification cannot be processed for any reason.
 */
export async function googlePlayNotification(env, r) {
  // developer.android.com/google/play/billing/rtdn-reference#encoding
  // developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions
  const outerjson = await r.json();
  // may throw if invalid JSON
  const notif = new Rtdn(outerjson).notification;
  await processGooglePlayNotification(env, notif);
  return r200t("OK");
}

/**
 * @param {any} env
 * @param {DeveloperNotification} notif
 * @throws {Error} if notif cannot be processed for any reason whatsoever.
 */
async function processGooglePlayNotification(env, notif) {
  if (notif == null) {
    throw new Error("Invalid notification");
  }
  // Handle the notification based on its type
  // ref: codelabs.developers.google.com/maximise-your-play-billing-integration
  if (notif.onetime) {
    await handleOneTimeProductNotification(env, notif.onetime);
  }
  if (notif.sub) {
    await handleSubscriptionNotification(env, notif.sub, notif.test != null);
  }
  if (notif.void) {
    await handleVoidedPurchaseNotification(env, notif.void, notif.test != null);
  }
  if (notif.test) {
    await handleTestNotification(notif.test);
  }
  logi(
    `notif: processed ${notif.version}, ${notif.packageName}, ${notif.eventTimeMillis}; test? ${notif.test != null}`,
  );
}

/**
 * @param {any} env
 * @param {OneTimeProductNotification} notif
 */
async function handleOneTimeProductNotification(env, notif) {
  if (notif == null || notif.purchaseToken == null) {
    throw new Error("onetime: invalid notif: " + notif);
  }

  const purchasetoken = notif.purchaseToken;
  const sku = notif.sku || "";
  const obstoken = await obfuscate(purchasetoken);
  const notifType = onetimeNotificationTypeStr(notif);

  if (emptyString(sku) || !knownOnetimeProductsAndPlans.has(sku)) {
    // TODO: worker analytics
    loge(`onetime: type? ${notifType}; unknown sku ${sku} for ${obstoken}`);
    return;
  }

  // allow errors from async/await to propagate, so google rtdn will retry
  const purchase2 = await getOnetimeProductV2(env, purchasetoken);
  const test = isOnetimeTest2(purchase2);

  return als.run(new ExecCtx(env, test, obstoken), async () => {
    const ackd = isOnetimeAck2(purchase2);
    const consumed = isOnetimeAllConsumed2(purchase2);
    const orderId = purchase2.orderId || "";
    const productIds = allProducts2(purchase2);
    const unconsumedProductIds = unconsumedProducts2(purchase2);
    const paid = isOnetimePaid2(purchase2);
    const cancelled = isOnetimeCancelled2(notif, purchase2);
    const pending = isOnetimeUnpaid2(purchase2);
    const onetimeState = onetimePurchaseStateStr2(purchase2);

    /** @type {string?} */
    let cid = null;

    try {
      // register purchase rightaway regardless of its veracity;
      // so it can be later revoke/refunded, as needed.
      cid = await getCidThenPersistProduct(env, purchase2);
    } catch (err) {
      loge(
        `onetime: no cid ${cid} / tok: ${obstoken} ${sku}/${productIds}: ${err.message}; test? ${test}`,
      );
      // TODO: leave upto the client to trigger a refund like done for subs?
      // refund the purchase as we have no way to link it to a user; otherwise it will be "lost" and unrevokable forever.
      return refundOrder(env, orderId);
    }

    /** @type {ProductPurchaseV2?} */
    let linkedPurchase2 = null;
    /** @type {string?} */
    let linkedPurchaseId = null;
    try {
      const [dblinktoken, dblinkmeta] = await linkedOnetimePurchases2(
        env,
        cid,
        purchasetoken,
      );
      linkedPurchaseId = dblinktoken;
      linkedPurchase2 = dblinkmeta;
    } catch (err) {
      loge(
        `onetime: err linking for ${cid} / tok: ${obstoken} ${sku}/${productIds}: ${err.message}; test? ${test}`,
      );
      // return error as there can be atmost 2 active onetime purchases allowed
      // the first purchase is assumed to be expiring soonish (like in 90d)
      // while the second one is assumed to be "taking over" when the first one does.
      // TODO: attempt refund?
      return r409j({
        error: "cannot link purchase",
        details: err.message,
        cid: cid,
        purchaseId: test ? purchasetoken : obstoken,
        sku: sku,
        test: test,
      });
    }

    await registerOrUpdateOnetimePurchase(
      env,
      cid,
      purchasetoken,
      purchase2,
      linkedPurchaseId,
    );

    const plan = onetimeDeferredPlan(purchase2, linkedPurchase2);

    logi(
      `onetime: ${notifType} / ${onetimeState} for ${cid} / tok: ${obstoken} sku=${sku} all: ${productIds} + uncon: ${unconsumedProductIds} / ackd? ${ackd} con? ${consumed} linked? ${linkedPurchaseId} ; test? ${test} / p=${JSON.stringify(plan ? plan.json : null)}`,
    );

    if (pending) {
      logi(
        `onetime: purchase pending ${onetimeState}; ${cid} / tok: ${obstoken}; test? ${test}`,
      );
      return;
    }

    if (cancelled) {
      logi(
        `onetime: cancelled ${onetimeState}; ${cid} / tok: ${obstoken}; test? ${test}`,
      );
      for (const tries of [1, 10]) {
        await sleep(tries); // wait 1s, then 10s
        try {
          const deletedEnt = await deleteWsEntitlement(env, cid);
          logi(
            `onetime: revoked (deleted? ${deletedEnt}) ent for ${cid} / tok: ${obstoken} ${sku}/${productIds}; test? ${test}`,
          );
          break;
        } catch (e) {
          loge(
            `onetime: err revoking ent for ${cid} / tok: ${obstoken} ${sku}/${productIds}: ${e.message}; test? ${test}`,
          );
        }
      }

      // A cancelled/refunded onetime purchase may have a consumed predecessor
      // whose synthetic expiry (start + sku duration) is still in the future.
      // In that case, delete the (possibly far-future) entitlement set by the
      // cancelled purchase and re-issue a fresh one anchored to the consumed
      // purchase's expiry (WS grants a minimum of 1 month per PUT).
      try {
        const linkedPlan = await activeConsumedOnetimePlan(
          env,
          cid,
          purchasetoken,
        );
        if (linkedPlan != null) {
          logi(
            `onetime: cancelled ${cid} / tok: ${obstoken} but consumed linked purchase expiry ${linkedPlan.expiry} is future; re-issuing entitlement; test? ${test}`,
          );
          const wsuser = await getOrGenWsEntitlement(
            env,
            cid,
            linkedPlan.expiry,
            linkedPlan.plan,
            /*renew*/ true,
          );
          logi(
            `onetime: re-issued entitlement for ${cid} / tok: ${obstoken} ${sku}/${productIds} until ${wsuser?.expiry} (expected: ${linkedPlan.expiry}); test? ${test}`,
          );
        }
      } catch (err) {
        loge(
          `onetime: err re-issuing ent from consumed linked purchase for ${cid} / tok: ${obstoken}: ${err.message}; test? ${test}`,
        );
      }
      return;
    }

    if (!paid || pending) {
      logw(
        `onetime: unpaid ${onetimeState} ${cid} / tok: ${obstoken} sku=${sku} ${productIds}; test? ${test}`,
      );
      return;
    }

    if (plan == null) {
      // TODO: auto refund?
      throw new Error(
        `onetime: missing plan info ${cid} / tok: ${obstoken} sku=${sku} ${productIds}`,
      );
    }

    const expiry = plan.expiry;
    const ent = await getOrGenWsEntitlement(env, cid, expiry, plan.plan);
    if (ackd && consumed) {
      logi(
        `onetime: already ack/con: ${cid} / tok: ${obstoken} sku=${sku} ${productIds}; test? ${test}`,
      );
      return;
    }

    if (ent == null) {
      throw new Error(
        `onetime: no ent for ${cid} but onetime active; sku=${sku}/${productIds}`,
      );
    }
    if (ent.status === "banned") {
      loge(
        `onetime: ${ent.status} ${cid} sku=${sku} ${productIds}; test? ${test}`,
      );
      return; // never ack but report success
    }
    if (ent.status === "expired") {
      // TODO: reissue entitlement?
      throw new Error(
        `onetime: ent expired ${cid} but onetime active; sku=${sku} ${productIds}`,
      );
    }

    if (!ackd) {
      // TODO: separate out ackd but not-consumed productIds and only consume those?
      await ackOnetimePurchases(env, productIds, purchasetoken, ent);
    }
    return;
  });
}

/**
 * @param {any} env
 * @param {SubscriptionNotification} notif
 * @param {boolean} test
 * @returns {Promise<boolean>}
 * @throws {Error} if notif cannot be processed for any reason whatsoever.
 */
async function handleSubscriptionNotification(env, notif, test) {
  // developer.android.com/google/play/billing/lifecycle/subscriptions
  // developer.android.com/google/play/billing/security#verify
  if (notif == null || notif.purchaseToken == null) {
    throw new Error("Invalid subscription notification:" + notif);
  }

  const purchasetoken = notif.purchaseToken;
  const typ = notificationTypeStr(notif);
  // tokens & state not retrievable 60d after expiry
  const sub = await getSubscription(env, purchasetoken);
  test = test || sub.testPurchase != null;
  const revoked = notif.notificationType === 12; // SUBSCRIPTION_REVOKED
  const obstoken = await obfuscate(purchasetoken);
  // TODO: handle SUBSCRIPTION_PAUSED, SUBSCRIPTION_DEFERRED, SUBSCRIPTION_RESTORED

  return als.run(new ExecCtx(env, test, obstoken), async () => {
    logi(`sub: ${typ} for ${obstoken} test? ${test}`);

    /** @type {string?} */
    let cid = null;

    try {
      cid = await getCidThenPersist(env, sub);
    } catch (err) {
      loge(
        `sub: no cid ${cid} / tok: ${obstoken} for ${typ}: ${err.message}; test? ${test}`,
      );
      // the client would attempt to acknowledge the purchase as we haven't
      // via googlePlayAcknowledgePurchase; and failing to persist cid
      // should prompt the client (if we return 409) to trigger a refund
    }

    return processSubscription(env, cid, sub, purchasetoken, revoked);
  });
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {SubscriptionPurchaseV2} sub - Subscription purchase.
 * @param {string} purchasetoken - Purchase token.
 * @param {boolean} revoked - Whether the subscription was revoked.
 * @returns {Promise<boolean>}
 */
async function processSubscription(env, cid, sub, purchasetoken, revoked) {
  const test = /*TODO: testmode() ||*/ sub.testPurchase != null;

  const state = sub.subscriptionState;
  // RECOVERED, RENEWED, PURCHASED, RESTARTED must have "active" states
  const active = state === "SUBSCRIPTION_STATE_ACTIVE";
  // Usually, state is set to EXPIRED on notification type REVOKED & EXPIRED
  // For states CANCELED, ON_HOLD, IN_GRACE_PERIOD, PAUSED, access must not be revoked.
  // use lineItems.expiryTime to determine the exact product to revoke access to.
  const expired = state === "SUBSCRIPTION_STATE_EXPIRED";
  // sub stands canceled but may not have expired. That is, for an auto renewing plan,
  // all items have autoRenewEnabled set to false.
  // Also happens if the user has upgraded / downgraded their subscription.
  const cancelled = state === "SUBSCRIPTION_STATE_CANCELED";
  const unpaid = state === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";
  // Per docs, only PURCHASED and RENEWED have to be acknowledged.
  const ackd =
    sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
  // for expired and cancelled subs, the sub may have been upgraded or downgraded
  // instead of auto-renewed: developer.android.com/google/play/billing/subscriptions#handle-deferred-replacement
  const replaced = expired || cancelled ? replacing(sub) : false;
  const obsoleted = await isLinkedPurchaseToken(env, purchasetoken);
  const obstoken = obsToken();

  logd(
    `sub: new ${cid} ${obstoken}: ${state} (active? ${active} / cancelled? ${cancelled} / expired? ${expired} / revoked? ${revoked} / unpaid? ${unpaid} / replaced? ${replaced} / ackd? ${ackd} / obsoleted? ${obsoleted}) test? ${test}`,
  );

  // Play Billing deletes a purchaseToken after 60d from expiry
  await registerOrUpdateActiveSubscription(env, cid, purchasetoken, sub);

  if (obsoleted) {
    logi(`sub: token ${obstoken} is obsoleted, cannot ack`);
    if (!ackd) {
      await ackSubscriptionWithoutEntitlement(env, purchasetoken);
    }
    // Subscription acknowledged without entitlement
    return true;
  }

  // developer.android.com/google/play/billing/subscriptions#pending
  if (active) {
    // SUBSCRIPTION_PURCHASED; Acknowledge
    const gprod = subscriptionInfo(sub);
    if (gprod == null) {
      loge(`sub: skip ack sub ${cid} test? ${test}; no product info`);
      return;
    }
    const expiry = gprod.expiry;
    // const productId = gprod.productId;
    const plan = gprod.plan;

    // TODO: check if this purchase token is not obsoleted by any other linked tokens
    // archive.vn/JASLQ / medium.com/androiddevelopers/implementing-linkedpurchasetoken-correctly-to-prevent-duplicate-subscriptions-82dfbf7167da
    // TODO: check if expiry/productId/plan are valid
    // TODO: handle entitlement for multiple product ids
    const ent = await getOrGenWsEntitlement(env, cid, expiry, plan);
    if (ackd) {
      logi(`sub: already acknowledged: ${cid} test? ${test}`);
      return true;
    }
    if (ent == null) {
      throw new Error(`sub: no ent for ${cid} but sub active; test? ${test}`);
    }
    if (ent.status === "banned") {
      loge(`sub: ${ent.status} ${cid} test? ${test}`);
      return true; // never ack but report success
    }
    if (ent.status === "expired") {
      // TODO: retry?
      throw new Error(`sub: ent expired ${cid} but sub active; test? ${test}`);
    }
    // developer.android.com/google/play/billing/integrate#process
    // developer.android.com/google/play/billing/subscriptions#handle-subscription
    await ackSubscription(env, purchasetoken, ent);
    return true; // successfully acknowledged
  } else if (cancelled || expired || revoked || unpaid) {
    const allok = true;
    // on revoke / unpaid, delete entitlement
    const now = Date.now();
    // developer.android.com/google/play/billing/subscriptions#cancel-refund-revoke
    for (const item of sub.lineItems) {
      const productId = item.productId;

      // deferring line items do not have expiryTime set; and so they musn't be processed
      // developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#ReplacementCancellation
      const deferring = item.deferredItemReplacement != null;
      const expiry = item.expiryTime ? new Date(item.expiryTime) : new Date(0);
      const autorenew = item.autoRenewingPlan
        ? item.autoRenewingPlan.autoRenewEnabled
        : false;
      logi(
        `sub: expire/cancel sub ${cid} ${productId} at ${expiry} (now: ${now}) (cancel? ${cancelled} / expired? ${expired} / revoked? ${revoked} / unpaid? ${unpaid} / renew? ${autorenew} / replace? ${replaced} / defer? ${deferring})`,
      );

      if ((revoked && !replaced) || unpaid) {
        for (const tries of [1, 10]) {
          await sleep(tries); // Wait 1s, 10s
          try {
            // TODO: validate if productId being revoked/unpaid even grants a WSEntitlement
            const deletedEnt = await deleteWsEntitlement(env, cid);
            logi(
              `sub: revoked/unpaid (deleted? ${deletedEnt}) sub ent for ${cid} ${productId}`,
            );
            break;
          } catch (e) {
            // TODO: set allok to false?
            loge(`sub: err revoking ent for ${cid} ${productId}: ${e.message}`);
          }
        }
      } else if (!autorenew && !deferring && expiry.getTime() < now) {
        // TODO: set allok to false?
        // TODO: check if WSUser expiry is far into the future (a lot of grace period
        // even though sub has expired), if so, delete it or let the user use it?
        // await deleteWsEntitlement(env, cid);
        // needed? await revokeSubscription(env, cid, productId, purchasetoken);
        logw(
          `sub: skip revoke1 for ${cid} / ${state} ${productId} at ${expiry} (now: ${now}); user may have grace period or paused state`,
        );
      } else {
        // on expiry, we retain the entitlement for grace period
        const note = expired ? logi : loge;
        note(
          `sub: skip revoke2 for ${cid} / ${state} ${productId} at ${expiry} (now: ${now}); (cancel? ${cancelled} / expired? ${expired} / revoked? ${revoked} / unpaid? ${unpaid} / renew? ${autorenew} / replace? ${replaced} / defer? ${deferring})`,
        );
      }
    }

    return allok;
  } else {
    // SUBSCRIPTION_CANCELED, SUBSCRIPTION_ON_HOLD, SUBSCRIPTION_IN_GRACE_PERIOD, SUBSCRIPTION_PAUSED
    // developer.android.com/google/play/billing/subscriptions#cancel-refund-revoke
    logi(`sub: notif ${cid} / ${state}, no-op`);
    return true; // No action needed for these states
  }
}

/**
 * @param {any} env
 * @param {VoidedPurchaseNotification} notif
 * @param {boolean} test
 * @returns {Promise<void>}
 */
async function handleVoidedPurchaseNotification(env, notif, test) {
  const obstoken = await obfuscate(notif.purchaseToken || "");
  const note = notif.refundType === 1 ? logi : loge;
  // the purchase has been refunded/voided;
  // if the purchaseToken exists in the database, then
  // retrieve the corresponding entitlements
  // (like from ws table) and delete them.
  // TODO: worker analytics
  note(
    `void: purchase ${obstoken}, ${notif.orderId}, ${notif.productType}, ${notif.refundType}; test? ${test}`,
  );

  return als.run(new ExecCtx(env, test, obstoken), async () => {
    const purchaseToken = notif.purchaseToken;
    // 1 = PRODUCT_TYPE_SUBSCRIPTION, 2 = PRODUCT_TYPE_ONE_TIME
    const productType = notif.productType;

    // 1. Look up the purchase token in the database to get the cid
    const dbres = await dbx.playSub(dbx.db(env), purchaseToken);
    if (
      dbres == null ||
      !dbres.success ||
      dbres.results == null ||
      dbres.results.length <= 0
    ) {
      loge(`void: ${obstoken} not found in db; test? ${test}`);
      return;
    }

    const entry = dbres.results[0];
    const cid = entry.cid;
    const linkedtoken = entry.linkedtoken || null;

    if (emptyString(cid)) {
      loge(`void: no cid for ${obstoken}; test? ${test}`);
      return;
    }

    // fetch fresh meta from Google and update the DB if non-nil
    let freshMeta = null;
    try {
      if (productType === 1) {
        // PRODUCT_TYPE_SUBSCRIPTION
        freshMeta = await getSubscription(env, purchaseToken);
      } else if (productType === 2) {
        // PRODUCT_TYPE_ONE_TIME
        freshMeta = await getOnetimeProductV2(env, purchaseToken);
      } else {
        logw(
          `void: unknown productType ${productType} for ${cid} / ${obstoken}; test? ${test}`,
        );
      }
    } catch (err) {
      // Token may have expired or been purged by Google (tokens are deleted 60d
      // after subscription expiry); log and proceed to delete the entitlement.
      logw(
        `void: err fetching meta for ${cid} / ${obstoken}: ${err.message}; test? ${test}`,
      );
    }

    if (freshMeta != null) {
      try {
        await dbx.upsertPlaySub(
          dbx.db(env),
          cid,
          purchaseToken,
          linkedtoken,
          freshMeta,
        );
        logi(`void: updated meta for ${cid} / ${obstoken}; test? ${test}`);
      } catch (err) {
        loge(
          `void: err updating meta for ${cid} / ${obstoken}: ${err.message}; test? ${test}`,
        );
      }
    }

    // delete the entitlement for this cid
    for (const tries of [1, 10]) {
      await sleep(tries); // wait 1s, then 10s
      try {
        await deleteWsEntitlement(env, cid);
        logi(`void: deleted ent for ${cid} / ${obstoken}; test? ${test}`);
        break;
      } catch (e) {
        loge(
          `void: err deleting ent for ${cid} / ${obstoken}: ${e.message}; test? ${test}`,
        );
      }
    }

    // for voided onetime purchases, check whether a consumed predecessor
    // still has a future synthetic expiry. If so, re-issue a fresh
    // entitlement anchored to that expiry (WS grants min 1 month per PUT).
    if (productType === 2 /* PRODUCT_TYPE_ONE_TIME */) {
      try {
        const linkedPlan = await activeConsumedOnetimePlan(
          env,
          cid,
          purchaseToken,
        );
        if (linkedPlan != null) {
          logi(
            `void: voided ${obstoken} but consumed linked purchase expiry ${linkedPlan.expiry} is future; re-issuing entitlement for ${cid}; test? ${test}`,
          );
          const wsuser = await getOrGenWsEntitlement(
            env,
            cid,
            linkedPlan.expiry,
            linkedPlan.plan,
            /*renew*/ true,
          );
          logi(
            `void: refreshed entitlement for ${cid} / ${obstoken} until ${wsuser?.expiry} (expected: ${linkedPlan.expiry}); test? ${test}`,
          );
        }
      } catch (err) {
        loge(
          `void: err re-issuing ent from consumed linked purchase for ${cid} / ${obstoken}: ${err.message}; test? ${test}`,
        );
      }
    }
  });
}

/**
 * @param {TestNotification} notif
 */
async function handleTestNotification(notif) {
  logi(`test: ${notif.version}`);
}

/**
 * Retrieving sub for an invalid purchase token will error out. A purchase token
 * may go invalid 60d after purchase expiry (in case of subscriptions, for example).
 * @param {any} env
 * @param {string} purchaseToken
 * @returns {Promise<SubscriptionPurchaseV2>}
 * @throws {Error} - If the response is not as expected (ex: purchase token is invalid)
 */
async function getSubscription(env, purchaseToken) {
  // GET
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/purchases/subscriptionsv2/tokens/{purchaseToken}'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const url = `${iap2}${purchaseToken}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const gmsg = await gerror(r);
    throw new Error(`err getting sub: ${r.status} ${gmsg}`);
  }
  const json = await consumejson(r);
  if (json != null && json.kind === "androidpublisher#subscriptionPurchaseV2") {
    if (log.debug) logd("sub: get product", env.CF_RAY, JSON.stringify(json));
    return new SubscriptionPurchaseV2(json);
  } else {
    // TODO: should the json be logged instead?
    throw new Error(`sub: json err ${r.status}: ${JSON.stringify(json)}`);
  }
}

/**
 * @deprecated use getOnetimeProductV2; doesn't require productId to get information on a purchaseToken
 * @param {any} env
 * @param {string} productId
 * @param {string} purchaseToken
 * @returns {Promise<ProductPurchaseV1>}
 * @throws {Error} - If the response is not as expected.
 */
async function getOnetimeProduct(env, productId, purchaseToken) {
  // GET
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/purchases/products/{productId}/tokens/{purchaseToken}'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const url = `${iap4}${productId}${tokpath}${purchaseToken}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const gmsg = await gerror(r);
    throw new Error(`oneetime: get err: ${r.status} ${gmsg}`);
  }
  const json = await consumejson(r);
  if (json != null && !emptyString(json.kind)) {
    if (log.debug) {
      logd(`onetime: getproduct ${env.CF_RAY} ${JSON.stringify(json)}`);
    }
    return new ProductPurchaseV1(json);
  } else {
    throw new Error(`onetime: json err ${r.status}: ${JSON.stringify(json)}`);
  }
}

/**
 * ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/get
 * @param {any} env
 * @param {string} purchaseToken
 * @returns {Promise<ProductPurchaseV2>}
 * @throws {Error} - If the response is not as expected.
 */
async function getOnetimeProductV2(env, purchaseToken) {
  // GET
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/purchases/productsv2/tokens/{purchaseToken}'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const url = `${iap3}${purchaseToken}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const gmsg = await gerror(r);
    throw new Error(`onetime: get v2 err: ${r.status} ${gmsg}`);
  }
  const json = await consumejson(r);
  if (json != null && !emptyString(json.kind)) {
    if (log.debug) {
      logd(`onetime: get product v2 ${env.CF_RAY} ${JSON.stringify(json)}`);
    }
    return new ProductPurchaseV2(json);
  } else {
    throw new Error(
      `onetime: v2 json err ${r.status}: ${JSON.stringify(json)}`,
    );
  }
}

/**
 * @param {any} env
 * @param {string} orderId
 * @returns {Promise<void>}
 */
async function refundOrder(env, orderId, revoke = true) {
  // POST
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/orders/{orderId}:refund'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const url = `${iap5}${orderId}${refundsuffix}?${revoke ? revokeparam : cancelparam}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(url, { method: "POST", headers });
  if (!r.ok) {
    const gmsg = await gerror(r);
    throw new Error(`onetime: refund err: ${r.status} ${gmsg}`);
  }
}

/**
 * @param {any} env
 * @param {string} cid
 * @param {string} purchaseToken
 * @param {boolean} test
 * @returns {Promise<Response>}
 */
async function refundOnetimePurchase(env, cid, purchaseToken, test) {
  if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
    return r400j({ error: "missing/invalid client id" });
  }
  if (emptyString(purchaseToken)) {
    return r400j({ error: "missing purchase token" });
  }

  // TODO: fetch from db if onetime purchase not retrivable from Google
  const purchase2 = await getOnetimeProductV2(env, purchaseToken);
  // the refund window depends on purchase time, and so linked purchases
  // which adjust the expiry aren't necessary
  // TODO: do not refund if any linked token is not consumed
  const plan = onetimePlan(purchase2);
  const refunded = isOnetimeRefunded2(purchase2);
  const fullyRefunded = isOnetimeFullyRefunded2(purchase2);
  const testPurchase = isOnetimeTest2(purchase2);
  const orderId = purchase2.orderId;
  const obstoken = obsToken();

  // TODO: compare purchase2.cid and arg(cid)?
  if (testPurchase !== test) {
    logw(
      `onetime: refund test? ${test} !== purchase-test? ${testPurchase} for ${cid} / tok: ${obstoken}`,
    );
    return r400j({
      error: "cannot refund, test mode mismatch",
      purchaseId: testPurchase ? purchaseToken : obstoken,
      orderId: testPurchase ? orderId : undefined,
      cid: cid,
      test: test,
    });
  } // else: testPurchase === test

  let deleteEntitlement = fullyRefunded;

  logi(
    `onetime: refund request for ${cid}; orderId=${orderId} / tok=${obstoken} / refunds: partial? ${refunded} & full? ${fullyRefunded} / test? ${test}`,
  );

  if (emptyString(orderId)) {
    return r400j({
      error: "missing product order",
      purchaseId: test ? purchaseToken : obstoken,
      orderId: test ? orderId : undefined,
      cid: cid,
      test: test,
    });
  }

  // let refunds go through if no such plan exists
  if (!fullyRefunded) {
    if (plan != null && !plan.withinRefundWindow) {
      // TODO: if refunded already, then skip to deleteWsEntitlment, if any.
      return r400j({
        error: "refund window exceeded",
        purchaseId: test ? purchaseToken : obstoken,
        orderId: test ? orderId : undefined,
        windowDays: plan.refundWindowDays,
        start: plan.startDate,
        expiry: plan.expiryDate,
        cid: cid,
        test: test,
      });
    }

    // issues a full refund
    await refundOrder(env, orderId);

    // TODO: OK to not delete entitlement on partial refunds?
    deleteEntitlement = true;
  }

  let deletedEnt = false;
  if (deleteEntitlement) {
    // TODO: retry?
    try {
      // if no entitlement exists there's nothing to revoke; that's okay
      deletedEnt = await deleteWsEntitlement(env, cid);
    } catch (e) {
      // TODO: worker analytics?
      loge(`onetime: refund ent delete err for ${cid}: ${e.message}`);
    }
  }

  logi(
    `onetime: for ${cid}; refunded order ${orderId} / tok=${obstoken} / deleted? ${deletedEnt} / test? ${test}`,
  );

  return r200j({
    success: true,
    message: "refunded onetime purchase",
    hadEntitlement: plan != null,
    deletedEntitlement: deletedEnt,
    wasAlreadyFullyRefunded: fullyRefunded,
    purchaseId: test ? purchaseToken : obstoken,
    orderId: test ? orderId : undefined,
    test: test,
    cid: cid,
  });
}

/**
 * developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/cancel
 * @param {any} env - Workers environment.
 * @param {Request} req - HTTP request.
 * @return {Promise<Response>} - Response indicating the result of the operation.
 */
export async function cancelSubscription(env, req) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return r405j({ error: "method not allowed" });
  }

  const cid = cidOf(req);
  const purchaseToken = purchaseTokenOf(req);
  let test = isTest(req);
  const sku = skuOf(req) || stdProductId;
  // TODO: use vcode = url.path.get("vcode") to accept or reject cancellation

  if (emptyString(purchaseToken)) {
    return r400j({ error: "missing purchase token" });
  }
  if (emptyString(sku)) {
    return r400j({ error: "missing product id" });
  }
  if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
    return r400j({ error: "missing/invalid client id" });
  }

  const obstoken = await obfuscate(purchaseToken);

  return await als.run(new ExecCtx(env, test, obstoken), async () => {
    logd(`cancel: ${cid}; ${sku} for ${cid} / tok: ${obstoken}; test? ${test}`);

    const dbres = await dbx.playSub(dbx.db(env), purchaseToken);
    if (
      dbres == null ||
      !dbres.success ||
      dbres.results == null ||
      dbres.results.length <= 0
    ) {
      loge(`cancel: not in db ${cid} / tok: ${obstoken}; test? ${test}`);
      return r400j({
        error: "subscription not found",
        purchaseId: obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    }
    const entry = dbres.results[0];
    const storedcid = entry.cid;
    // TODO: only allow credentialless clients to access this endpoint
    if (accountIdentifiersImmutable() && storedcid !== cid) {
      loge(`cancel: cid mismatch: ${cid} != ${storedcid}`);
      return r400j({
        error: "cannot cancel, cid mismatch",
        purchaseId: obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    }

    const obsoleted = await isLinkedPurchaseToken(env, purchaseToken);
    if (obsoleted) {
      loge(`cancel: tok ${obstoken} for ${cid} is obsoleted`);
      return r403j({
        error: "purchase token obsolete",
        purchaseId: obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    }

    if (knownOnetimeProductsAndPlans.has(sku)) {
      // TODO: do not revoke; but cancel only?
      return await refundOnetimePurchase(env, cid, purchaseToken, test);
    }

    const subdb = new SubscriptionPurchaseV2(JSON.parse(entry.meta));
    const sub = await getSubscription(env, purchaseToken);

    // re-grab test domain from fetched subscription
    const testPurchase = sub.testPurchase != null;

    if (testPurchase !== test) {
      loge(
        `cancel: test mismatch for ${cid} / tok: ${obstoken}; expected test? ${test} but got test? ${testPurchase}`,
      );
      return r400j({
        error: "cannot cancel, test domain mismatch",
        purchaseId: testPurchase ? purchaseToken : obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    } // else: testPurchase === test

    if (!subscriptionsMoreOrLessEqual(subdb, sub)) {
      loge(`cancel: sub mismatch for ${cid} with ${obstoken}`);
      return r400j({
        error: "cannot cancel, subscription mismatch",
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }

    // TODO: compare sub with sub got from db if "plan" (gent) is valid
    const expired = sub.subscriptionState === "SUBSCRIPTION_STATE_EXPIRED";
    const cancelled = sub.subscriptionState === "SUBSCRIPTION_STATE_CANCELED";

    if (cancelled || expired) {
      // If the subscription has expired, we cannot cancel it.
      loge(`cancel: sub ${cid} / tok: ${obstoken} sub cancelled or expired`);
      return r200j({
        success: false,
        message: "cannot revoke, subscription cancelled or expired",
        expired: expired,
        cancelled: cancelled,
        cancelCtx: sub.canceledStateContext,
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }
    // curl -X POST \
    //   -H "Accept: application/json" \
    //   -d '{"cancellationType": "USER_REQUESTED_STOP_RENEWALS"}' \
    //   "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/purchases/subscriptions/tokens/EXAMPLE_TOKEN_STRING_12345:cancel"
    const cancelurl = `${iap1}${purchaseToken}${cancelsuffix}`;
    const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    };
    const body = JSON.stringify({
      // user_requested_stop_renewals can be restored later.
      cancellationType: "USER_REQUESTED_STOP_RENEWALS",
    });
    // May have been cancelled already or expired or invalid
    const r = await fetch(cancelurl, {
      method: "POST",
      headers: headers,
      body: body,
    });

    if (!r.ok) {
      const gerr = await gerror(r);
      loge(`cancel: sub err: ${cid} / tok: ${obstoken}; ${r.status} ${gerr}`);
      return r400j({
        error: `failed to cancel subscription: ${r.status} ${gerr}`,
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    } else {
      logi(`cancel: sub done ${cid} / tok: ${obstoken}; test? ${test}`);
      return r200j({
        success: true,
        message: "cancelled subscription",
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }
  });
}

/**
 * developer.android.com/google/play/billing/subscription-with-addons#revoke-refund-subscription-with-addons
 * @param {any} env - Workers environment.
 * @param {Request} req - HTTP request.
 * @returns {Promise<Response>}
 */
export async function revokeSubscription(env, req) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return r405j({ error: "method not allowed" });
  }

  const cid = cidOf(req);
  const purchaseToken = purchaseTokenOf(req);
  let test = isTest(req);
  const sku = skuOf(req) || stdProductId;
  // TODO: only supported vcode = url.path("vcode") can revoke purchase

  if (emptyString(purchaseToken)) {
    return r400j({ error: "missing purchase token" });
  }
  if (emptyString(sku)) {
    return r400j({ error: "missing product id" });
  }
  if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
    return r400j({ error: "missing/invalid client id" });
  }

  const obstoken = await obfuscate(purchaseToken);

  return await als.run(new ExecCtx(env, test, obstoken), async () => {
    // TODO: only allow credentialless clients to access this endpoint
    logd(`sub: revoke for ${cid}; test? ${test} ${sku} for ${obstoken}`);

    const dbres = await dbx.playSub(dbx.db(env), purchaseToken);
    if (
      dbres == null ||
      !dbres.success ||
      dbres.results == null ||
      dbres.results.length <= 0
    ) {
      loge(`sub: revoke not found in db ${cid} / tok: ${obstoken}`);
      return r400j({
        error: "subscription not found",
        purchaseId: obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    }
    const entry = dbres.results[0];
    const storedcid = entry.cid;
    if (accountIdentifiersImmutable() && storedcid !== cid) {
      loge(`sub: revoke cid mismatch: ${cid} != ${storedcid}`);
      return r400j({
        error: "cannot revoke, cid mismatch",
        purchaseId: obstoken,
        cid: cid,
        sku: sku,
        test: test,
      });
    }

    // reject revoke on an obsoleted purchase token (it is a linkedtoken for a
    // newer purchase that supersedes it). Ack and consume are still allowed.
    const obsolete = await isLinkedPurchaseToken(env, purchaseToken);
    if (obsolete) {
      loge(`revoke: tok ${obstoken} for ${cid} is obsoleted`);
      return r403j({
        error: "purchase token obsolete",
        purchaseId: obstoken,
        cid: cid,
        sku: sku,
        test: test,
      });
    }

    if (knownOnetimeProductsAndPlans.has(sku)) {
      return await refundOnetimePurchase(env, cid, purchaseToken, test);
    }

    const subdb = new SubscriptionPurchaseV2(JSON.parse(entry.meta));
    const sub = await getSubscription(env, purchaseToken);
    // grab test domain from fetched subscription
    const testPurchase = sub.testPurchase != null;

    if (testPurchase !== test) {
      loge(
        `revoke: test mismatch for ${cid} / tok: ${obstoken}; expected test? ${test} but got test? ${testPurchase}`,
      );
      return r400j({
        error: "cannot revoke, test domain mismatch",
        purchaseId: testPurchase ? purchaseToken : obstoken,
        sku: sku,
        test: test,
        cid: cid,
      });
    } // else: testPurchase === test

    if (!subscriptionsMoreOrLessEqual(subdb, sub)) {
      loge(`revoke: sub mismatch for ${cid} with ${obstoken}`);
      return r400j({
        error: "cannot revoke, subscription mismatch",
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }

    // TODO: test against db entry?
    const expired = sub.subscriptionState === "SUBSCRIPTION_STATE_EXPIRED";
    const cancelled = sub.subscriptionState === "SUBSCRIPTION_STATE_CANCELED";

    if (cancelled || expired) {
      // If the subscription is cancelled, we cannot revoke it.
      loge(`revoke: ${cid} / tok: ${obstoken} sub cancelled, cannot revoke`);
      return r200j({
        success: false,
        message: "cannot revoke, subscription cancelled or expired",
        expired: expired,
        cancelled: cancelled,
        cancelCtx: sub.canceledStateContext,
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }

    const gprod = subscriptionInfo(sub);

    // if gprod is null (no such plan), allow unconditional refunds
    if (gprod != null && !gprod.withinRefundWindow) {
      // If sub is not within threshold millis ago, do not revoke it.
      loge(
        `revoke: ${cid} / tok: ${obstoken} sub started too long ago, cannot revoke`,
      );
      return r400j({
        error: "cannot revoke, sub too old, contact support",
        windowDays: gprod.refundWindowDays,
        start: gprod.startDate,
        expiry: gprod.expiryDate,
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }

    // windscribe session is deleted when handleSubscriptionNotification
    // is called for SUBSCRIPTION_REVOKED (see: deleteWSEntitlement).

    const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);

    // POST
    //   -H 'Accept: application/json' \
    //   -H 'Content-Type: application/json' \
    //   -d '{
    //     "revocationContext": {
    //       "proratedRefund": {},
    //       "fullRefund": {},
    //       "itemBasedRefund": {
    //          "productId": "string",
    //       },
    //       {},
    //     }
    //   }'
    //   'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/subscriptionsv2/tokens/{token}:revoke'
    const revokeurl = `${iap2}${purchaseToken}${revokesuffix}`;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    };

    const r = await fetch(revokeurl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        revocationContext: {
          fullRefund: {},
        },
      }),
    });

    if (!r.ok) {
      const gerr = await gerror(r);
      loge(`revoke: sub err: ${cid} / tok: ${obstoken} ${r.status} ${gerr}`);
      // TODO: retry for 3 days with pipeline?
      return r400j({
        error: `failed to revoke subscription: ${r.status} ${gerr}`,
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    } else {
      logi(`revoke: done sub for ${cid} / tok: ${obstoken}; test? ${test}`);
      return r200j({
        success: true,
        hadEntitlement: gprod != null,
        message: "revoked subscription",
        purchaseId: test ? purchaseToken : obstoken,
        test: test,
        cid: cid,
        sku: sku,
      });
    }
  });
}

/**
 * @param {any} env - Workers environment.
 * @param {string} tok - Google Play purchase token.
 * @returns {Promise<void>}
 * @throws {Error} - If the acknowledgment fails.
 */
async function ackSubscriptionWithoutEntitlement(env, tok) {
  return ackSubscription(env, tok, null, true);
}

/**
 * @param {any} env - Workers environment.
 * @param {string[]} productIds - all productIds associated with the purchase token.
 * @param {string} tok - Google Play purchase token.
 * @param {WSEntitlement?} ent - Windscribe entitlement.
 * @param {boolean} ackWithoutEntitlement - if true, allow acknowledgment even without an entitlement.
 * @returns {Promise<void>}
 * @throws {Error} - If no productIds to acknowledge or if acknowledgement fails.
 */
async function ackOnetimePurchases(
  env,
  productIds,
  tok,
  ent,
  ackWithoutEntitlement = false,
) {
  const cid = ent ? ent.cid : "w/o entitlement";
  logd(
    `onetime: ack/con for ${cid} / all: ${productIds} / force? ${ackWithoutEntitlement}`,
  );

  if (productIds == null || productIds.length <= 0) {
    throw new Error("no product ids to ack");
  }

  for (const productId of productIds) {
    if (productId == null) continue;
    // TODO: try-catch?
    await ackOnetimePurchase(
      env,
      productId,
      cid,
      tok,
      ent, // may be null
      ackWithoutEntitlement,
    );
    // just one ack per purchasetoken is enough
    // docs.godotengine.org/en/stable/tutorials/platform/android/android_in_app_purchases.html
    break;
  }
}

async function consumeOnetimePurchases(env, cid, unconsumedProductIds, tok) {
  logd(`onetime: ack/con for ${cid} / all: ${unconsumedProductIds}`);
  let anyconsumed = false;
  let log3 = loge;
  let errs = [];
  for (const productId of unconsumedProductIds) {
    if (productId == null) continue;
    try {
      await consumeOnetimePurchase(env, productId, cid, tok);
      anyconsumed = true;
      log3 = logw;
    } catch (err) {
      errs.push("con(" + productId + "): " + err.message);
      log3(`onetime: failed to consume ${productId} / ${cid}: ${err}`);
    }
    // consuming once per purchase token is enough?
  }
  if (!anyconsumed) {
    throw new Error(`${errs.join("; ")}`);
  }
  return anyconsumed;
}

/**
 * "Developers have the option to manually invoke consume on onetime lifetime
 * purchases, even though originally their re-purchase was restricted.
 * Non-consumable purchase is converted into a consumable, making it available
 * for re-purchase."
 * docs.apphud.com/docs/consumable-and-non-consumable-purchases
 * @param {any} env - Workers environment.
 * @param {string} productId
 * @param {string} cid - Client ID for logging purposes.
 * @param {string} tok - Google Play purchase token.
 */
async function consumeOnetimePurchase(env, productId, cid, tok) {
  const obs = obsToken();

  logd(`onetime: consume ${productId} / ${cid} / ${obs}`);

  // Ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume
  // POST
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/products/{productId}/tokens/{token}:consume'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const consumeurl = `${iap4}${productId}${tokpath}${tok}${consumesuffix}`;
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };

  const r = await fetch(consumeurl, {
    method: "POST",
    headers: headers,
  });

  if (!r.ok) {
    const gmsg = await gerror(r);
    // TODO: retry for 3 days with pipeline?
    throw new Error(
      `onetime: unexpected err consume ${obs}: ${r.status} for ${cid}; ${gmsg}`,
    );
  }

  logi(`onetime: consumed ${productId} / ${obs} for ${cid}`);

  go(refreshDatabaseState, env, cid, tok);
}

/**
 * Acknowledges a one-time purchase. If an entitlement is provided, it will be included in the developer payload.
 * If no entitlement is provided and ackWithoutEntitlement is false, the acknowledgment will be rejected. Throws
 * an error if the acknowledgement fails.
 * @param {any} env - Workers environment.
 * @param {string} productId
 * @param {string} cid - Client ID for logging purposes.
 * @param {string} tok - Google Play purchase token.
 * @param {WSEntitlement?} ent - Windscribe entitlement.
 * @param {boolean} ackWithoutEntitlement - if true, allow acknowledgment even without an entitlement.
 * @throws {Error} - If the acknowledgment fails.
 */
async function ackOnetimePurchase(
  env,
  productId,
  cid,
  tok,
  ent,
  ackWithoutEntitlement = false,
) {
  const obs = obsToken();
  logd(`onetime: ack ${productId} / ${obs} / force? ${ackWithoutEntitlement}`);
  // POST
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/products/{productId}/tokens/{token}:acknowledge' \
  // -H 'Accept: application/json' \
  // -H 'Content-Type: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  // -d '{"developerPayload": <string> "{\"ws\": \"entitlement\"}"}'
  const ackurl = `${iap4}${productId}${tokpath}${tok}${acksuffix}`;
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  if (ent == null && !ackWithoutEntitlement) {
    throw new Error(`onetime: err ack ${obs} for ${cid}; missing entitlement`);
  }
  if (attachEntitlementToAck && ent != null) {
    const body = JSON.stringify({
      developerPayload: JSON.stringify({
        ws: await ent.toClientEntitlement(env),
      }),
    });
    const r = await fetch(ackurl, {
      method: "POST",
      headers: headers,
      body: body,
    });
    if (!r.ok) {
      // TODO: retry for 3 days with pipeline?
      const gmsg = await gerror(r);
      throw new Error(
        `onetime: err ack ${obs}: ${r.status} for ${cid}; ${gmsg}`,
      );
    }
  } else {
    const r = await fetch(ackurl, { method: "POST", headers });
    if (!r.ok) {
      const gmsg = await gerror(r);
      // TODO: retry for 3 days with pipeline?
      throw new Error(
        `onetime: unexpected err ack ${obs}: ${r.status} for ${cid}; ${gmsg}`,
      );
    }
  }

  logi(`onetime: ackd ${productId} / ${obs} for ${cid}; ent? ${ent != null}`);
}

/**
 *
 * @param {any} env
 * @param {string} tok - Google Play purchase token.
 * @param {WSEntitlement} ent - Windscribe entitlement.
 * @param {boolean} ackWithoutEntitlement - if true, allow acknowledgment even without an entitlement.
 * @returns {Promise<void>}
 * @throws {Error} - If the acknowledgment fails.
 */
async function ackSubscription(env, tok, ent, ackWithoutEntitlement = false) {
  // POST
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{pkg}/purchases/subscriptions/tokens/abcDEF123ghiJKL456mnoPQR789:acknowledge' \
  // -H 'Accept: application/json' \
  // -H 'Content-Type: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  // -d '{"developerPayload": <string> "{\"ws\": \"entitlement\"}"}'
  const ackurl = `${iap1}${tok}${acksuffix}`;
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const obs = obsToken();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  if (ent != null) {
    const body = JSON.stringify({
      developerPayload: JSON.stringify({
        ws: await ent.toClientEntitlement(env),
      }),
    });
    const r = await fetch(ackurl, {
      method: "POST",
      headers: headers,
      body: body,
    });
    if (!r.ok) {
      // TODO: retry for 3 days with pipeline?
      const gmsg = await gerror(r);
      throw new Error(
        `sub: err ack for ${obs}: ${r.status} ${gmsg} for ${ent.cid}`,
      );
    }
  } else {
    if (!ackWithoutEntitlement) {
      throw new Error(`sub: no entitlement for ${obs}, cannot ack sub`);
    }
    // no entitlement, but ack anyway
    const r = await fetch(ackurl, { method: "POST", headers });
    if (!r.ok) {
      const gmsg = await gerror(r);
      // TODO: retry for 3 days with pipeline?
      throw new Error(`sub: err ack for ${obs}: ${r.status} ${gmsg}`);
    }
  }
}

/**
 * Acknowledges a Google Play purchase if all conditions are met.
 * The conditions are based on the logic in handleSubscriptionNotification:
 * - Subscription must be active (SUBSCRIPTION_STATE_ACTIVE)
 * - Purchase token must be valid
 * - Entitlement must be available and valid (not banned or expired)
 * - Subscription must not already be acknowledged
 *
 * @param {any} env - Worker environment
 * @param {Request} req - HTTP request containing purchase token
 * @returns {Promise<Response>} - HTTP response indicating success or failure
 */
export async function googlePlayAcknowledgePurchase(env, req) {
  let test = false;
  let purchasetoken = "";
  let obstoken = "";
  let cid = "";
  let sku = "";

  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return r405j({ error: "method not allowed" });
    }
    const post = req.method === "POST";
    // Parse request body to get purchase token
    const force = forceOf(req);
    purchasetoken = purchaseTokenOf(req);
    cid = cidOf(req);
    sku = skuOf(req) || stdProductId;
    test = isTest(req);
    // TODO: use vcode = url.path.get("vcode") to accept or reject purchases

    if (emptyString(purchasetoken)) {
      return r400j({ error: "missing purchase token" });
    }
    if (emptyString(sku)) {
      return r400j({ error: "missing product id" });
    }
    if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
      return r400j({ error: "missing/invalid client id" });
    }

    obstoken = await obfuscate(purchasetoken);

    return await als.run(new ExecCtx(env, test, obstoken), async () => {
      if (knownOnetimeProductsAndPlans.has(sku)) {
        const dbres = await dbx.playSub(dbx.db(env), purchasetoken);
        if (
          dbres == null ||
          !dbres.success ||
          dbres.results == null ||
          dbres.results.length <= 0
        ) {
          return r400j({
            error: "purchase not found",
            cid: cid,
            sku: sku,
            purchaseId: obstoken,
            test: test,
          });
        }
        const entry = dbres.results[0];
        const storedcid = entry.cid;
        // identifiers must be immutable for onetime purchases
        if (accountIdentifiersImmutable() && storedcid !== cid) {
          return r400j({
            error: "cid mismatch",
            cid: cid,
            storedCid: test ? storedcid : undefined,
            purchaseId: test ? purchasetoken : obstoken,
            sku: sku,
            test: test,
          });
        }

        /** @type {ProductPurchaseV2?} */
        let linkedPurchase2 = null;
        /** @type {string?} */
        let linkedPurchaseId = null;
        try {
          const [dblinktoken, dblinkmeta] = await linkedOnetimePurchases2(
            env,
            cid,
            purchasetoken,
            entry.linkedtoken || null,
          );
          linkedPurchaseId = dblinktoken;
          linkedPurchase2 = dblinkmeta;
        } catch (err) {
          loge(
            `onetime: ack/con err linking purchases for ${cid} / tok: ${obstoken} ${sku}: ${err.message}; test? ${test}`,
          );
          // return error as there can be atmost 2 active onetime purchases allowed
          // the first purchase is assumed to be expiring soonish (like in 90d)
          // while the second one is assumed to be "taking over" when the first one does.
          // client that sees 409 should attempt refund.
          return r409j({
            error: "cannot link purchase",
            details: err.message,
            cid: cid,
            purchaseId: test ? purchasetoken : obstoken,
            sku: sku,
            test: test,
          });
        }
        // TODO: if fetching purchase2 from Google fails, use onetime meta from db?
        const purchase2 = await getOnetimeProductV2(env, purchasetoken);
        const testPurchase = isOnetimeTest2(purchase2);
        const ackd = isOnetimeAck2(purchase2);
        const consumed = isOnetimeAllConsumed2(purchase2);
        // TODO: must sku match any productIds?
        const productIds = allProducts2(purchase2);
        const unconsumedProductIds = unconsumedProducts2(purchase2);
        const paid = isOnetimePaid2(purchase2);
        const pending = isOnetimeUnpaid2(purchase2);
        const cancelled = isOnetimeCancelled2(null, purchase2);
        const onetimeState = onetimePurchaseStateStr2(purchase2);

        logi(
          `onetime: ack/con ${onetimeState} for ${cid} / tok: ${obstoken} sku=${sku} all: ${productIds} + uncon: ${unconsumedProductIds} / ackd? ${ackd} con? ${consumed} linked? ${linkedPurchaseId}; test? ${test}`,
        );

        if (testPurchase !== test) {
          return r400j({
            error: "test domain mismatch",
            purchaseId: testPurchase ? purchasetoken : obstoken,
            linkedPurchaseId: testPurchase ? linkedPurchaseId : undefined,
            state: onetimeState,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            test: test,
          });
        } // else: test === testPurchase

        if (!paid || pending || cancelled) {
          return r400j({
            error: cancelled ? "purchase cancelled" : "purchase not completed",
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
            state: onetimeState,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            test: test,
          });
        }

        // obsoleted token may still be acknowledged, and if the linked (newer)
        // purchase has since been refunded/cancelled — making this consumed token
        // orphaned — we should still return the entitlement derived from this
        // purchase itself so the client isn't left without access.
        const obsoleted = await isLinkedPurchaseToken(env, purchasetoken);
        if (obsoleted) {
          logi(
            `onetime: ack tok ${obstoken} for ${cid} is obsoleted; checking for orphan entitlement`,
          );
          if (!ackd) {
            try {
              await ackOnetimePurchases(
                env,
                productIds,
                purchasetoken,
                null,
                true,
              );
            } catch (e) {
              loge(`onetime: err ack obsoleted ${obstoken}: ${e.message}`);
            }
          }

          // Attempt to recover an entitlement: the linked/active purchase may have
          // been refunded or cancelled, leaving this consumed token as an orphan.
          // onetimeDeferredPlan uses both purchase2 (this token) and linkedPurchase2
          // (the newer token's metadata) to compute the effective plan.
          const orphanGent = onetimeDeferredPlan(
            purchase2,
            linkedPurchase2,
            /*mustBeAckd*/ true,
          );
          if (orphanGent != null) {
            const orphanEnt = await getOrGenWsEntitlement(
              env,
              cid,
              orphanGent.expiry,
              orphanGent.plan,
            );
            const sendPayload =
              orphanEnt != null && orphanEnt.status === "valid";
            logi(
              `onetime: orphan ent for ${cid} / tok: ${obstoken} / valid? ${sendPayload}; test? ${test}`,
            );
            return r200j({
              success: true,
              message: sendPayload
                ? "onetime linked purchase acknowledged with recovered entitlement"
                : "onetime linked purchase acknowledged without entitlement",
              cid: cid,
              state: onetimeState,
              allProducts: productIds,
              unconsumedProducts: unconsumedProductIds,
              purchaseId: test ? purchasetoken : obstoken,
              linkedPurchaseId: test ? linkedPurchaseId : undefined,
              expiry: sendPayload ? orphanGent.expiryDate : undefined,
              sku: sku,
              test: test,
              developerPayload: sendPayload
                ? JSON.stringify({
                    ws: await orphanEnt.toClientEntitlement(env),
                  })
                : undefined,
            });
          }

          return r200j({
            success: true,
            message: "onetime linked purchase acknowledged without entitlement",
            cid: cid,
            state: onetimeState,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
            sku: sku,
            test: test,
          });
        }

        const gent = onetimeDeferredPlan(purchase2, linkedPurchase2);
        if (gent == null) {
          // such purchases can only be cancelled/refunded
          return r400j({
            error: "not a valid product; will be auto refunded",
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
            cid: cid,
            state: onetimeState,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            test: test,
          });
        }
        const expiry = gent.expiry;
        const ent = await getOrGenWsEntitlement(env, cid, expiry, gent.plan);
        if (!force && ent == null) {
          return r500j({ error: "failed to get entitlement", cid: cid });
        }
        if (ent?.status === "banned" && !force) {
          return r400j({
            error: "user banned",
            cid: cid,
            state: onetimeState,
            status: ent?.status,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            expiry: gent.expiryDate,
            test: test,
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
          });
        }
        if (ent?.status === "expired" && !force) {
          return r400j({
            error: "entitlement expired",
            cid: cid,
            state: onetimeState,
            status: ent?.status,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            expiry: gent.expiryDate,
            test: test,
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
          });
        }
        if (ent?.status !== "valid" && !force) {
          return r400j({
            error: "invalid entitlement status",
            status: ent?.status,
            cid: cid,
            sku: sku,
            allProducts: productIds,
            unconsumedProducts: unconsumedProductIds,
            expiry: gent.expiryDate,
            test: test,
            purchaseId: test ? purchasetoken : obstoken,
            linkedPurchaseId: test ? linkedPurchaseId : undefined,
          });
        }

        if (!ackd) {
          try {
            if (post) {
              await ackOnetimePurchases(env, productIds, purchasetoken, ent);
            } else {
              throw new Error("acknowledgment skipped for GET");
            }
          } catch (e) {
            loge(
              `onetime: err ack/con: ${cid} / tok: ${obstoken}: ${e.message}`,
            );
            return r500j({
              error: "failed to ack or consume",
              details: e.message,
              status: ent?.status,
              purchaseId: test ? purchasetoken : obstoken,
              linkedPurchaseId: test ? linkedPurchaseId : undefined,
              cid: cid,
              sku: sku,
              allProducts: productIds,
              unconsumedProducts: unconsumedProductIds,
              expiry: gent.expiryDate,
              test: test,
            });
          }
        }

        // TODO: sendPayload iff ent.userId has changed from previous entitlement
        const sendPayload = ent != null;

        logi(
          `onetime: ackd/con for ${cid} / tok: ${obstoken} / sentEnt? ${sendPayload}; test? ${test}`,
        );

        return r200j({
          success: true,
          message: "onetime purchase acknowledged",
          cid: cid,
          state: onetimeState,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          purchaseId: test ? purchasetoken : obstoken,
          linkedPurchaseId: test ? linkedPurchaseId : undefined,
          expiry: gent.expiryDate,
          sku: sku,
          test: test,
          developerPayload: sendPayload
            ? JSON.stringify({
                ws: await ent.toClientEntitlement(env),
              })
            : undefined,
        });
      } else {
        const dbres = await dbx.playSub(dbx.db(env), purchasetoken);
        if (
          dbres == null ||
          !dbres.success ||
          dbres.results == null ||
          dbres.results.length <= 0
        ) {
          loge(`ack: sub not found in db ${cid} / tok: ${obstoken}`);
          return r400j({
            error: "cannot ack, subscription not found",
            purchaseId: obstoken,
            cid: cid,
            sku: sku,
            test: test,
          });
        }
        const entry = dbres.results[0];
        const storedcid = entry.cid;
        // TODO: only allow credentialless clients to access this endpoint
        if (accountIdentifiersImmutable() && storedcid !== cid) {
          loge(`ack: sub cid mismatch: ${cid} != ${storedcid}`);
          return r400j({
            error: "cannot ack, cid mismatch",
            purchaseId: obstoken,
            cid: cid,
            sku: sku,
            test: test,
          });
        }

        // TODO: test if subdb and sub are equal?
        // const subdb = new SubscriptionPurchaseV2(JSON.parse(entry.meta));
        const sub = await getSubscription(env, purchasetoken);
        const testPurchase = sub.testPurchase != null;
        const state = sub.subscriptionState;
        const ackstate = sub.acknowledgementState;
        // TODO: must var sku match any productIds?
        const productIds = subAllProducts(sub);
        const active = state === "SUBSCRIPTION_STATE_ACTIVE";
        const cancelled = state === "SUBSCRIPTION_STATE_CANCELED";
        const expired = state === "SUBSCRIPTION_STATE_EXPIRED";
        const ackd = ackstate === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

        if (testPurchase !== test) {
          loge(`ack: err test domain mismatch for ${cid} with ${obstoken}`);
          return r400j({
            error: "test domain mismatch",
            purchaseId: testPurchase ? purchasetoken : obstoken,
            state: state,
            sku: sku,
            allProducts: productIds,
            test: test,
          });
        } // else: test === testPurchase

        logi(`ack: sub for ${obstoken} at ${state}/${ackstate}; test? ${test}`);

        // canceled subs could be expiring in the future
        if ((!active && !cancelled) || expired) {
          loge(`ack: err inactive: ${cid}, state: ${state}`);
          return r400j({
            error: "subscription not active",
            purchaseId: test ? purchasetoken : obstoken,
            state: state,
          });
        }

        const gprod = subscriptionInfo(sub);
        if (gprod == null) {
          // such purchases can only be cancelled/refunded
          loge(`ack: sub err invalid product for ${obstoken}`);
          return r400j({
            error: "not a valid product subscription; will be auto refunded",
            purchaseId: test ? purchasetoken : obstoken,
            cid: cid,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }

        const expiry = gprod.expiry;
        const productId = gprod.productId;
        const plan = gprod.plan;

        // TODO: check if expiry/productId/plan are valid
        // Play Billing deletes a purchaseToken after 60d from expiry
        await registerOrUpdateActiveSubscription(env, cid, purchasetoken, sub);
        if (Date.now() > expiry.getTime()) {
          return r400j({
            error: "subscription expired",
            cid: cid,
            sku: sku,
            allProducts: productIds,
            purchaseId: test ? purchasetoken : obstoken,
            expiry: gprod.expiryDate,
            test: test,
            state: state,
          });
        }

        try {
          // TODO: validate cid only for credential-less accounts
          // credentialed accounts can have different cids
          const existingCid = await getCidThenPersist(env, sub);
          if (accountIdentifiersImmutable() && existingCid !== cid) {
            loge(
              `ack: cid (us!=them) ${existingCid} != ${cid} for ${obstoken}`,
            );
            return r400j({
              purchaseId: test ? purchasetoken : obstoken,
              cid: cid,
              sku: sku,
              allProducts: productIds,
              test: test,
              state: state,
              error: "cid mismatch",
            });
          }
        } catch (e) {
          loge(`ack: err validating cid (${cid}): ${e.message}`);
          // returning 409 should trigger a refund workflow on the client
          // ref: handleSubscriptionNotification
          return r409j({
            purchaseId: test ? purchasetoken : obstoken,
            error: "invalid cid; cannot acknowledge",
            details: e.message,
            cid: cid,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }

        const obsoleted = await isLinkedPurchaseToken(env, purchasetoken);
        if (obsoleted) {
          logi(`ack: token ${obstoken} for ${cid} is obsoleted, cannot ack`);
          if (!ackd) {
            await ackSubscriptionWithoutEntitlement(env, purchasetoken);
          }
          return r200j({
            success: true,
            message: "subscription acknowledged without entitlement",
            cid: cid,
            purchaseId: test ? purchasetoken : obstoken,
            expiry: gprod.expiryDate,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }

        logi(`ack: sub ${cid} test? ${test} for ${obstoken} at ${expiry}`);

        // TODO: check if productId grants a WSEntitlement
        const ent = await getOrGenWsEntitlement(env, cid, expiry, plan);
        if (!force && !ent) {
          return r500j({ error: "failed to get entitlement", cid: cid });
        }
        if (ent?.status === "banned" && !force) {
          return r400j({
            error: "banned user",
            cid: cid,
            status: ent?.status,
            purchaseId: test ? purchasetoken : obstoken,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }
        if (ent?.status === "expired" && !force) {
          return r400j({
            error: "entitlement expired",
            cid: cid,
            status: ent?.status,
            purchaseId: test ? purchasetoken : obstoken,
            expiry: gprod.expiryDate,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }
        if (ent?.status !== "valid" && !force) {
          return r400j({
            error: "invalid entitlement status",
            status: ent?.status,
            cid: cid,
            purchaseId: test ? purchasetoken : obstoken,
            sku: sku,
            allProducts: productIds,
            test: test,
            state: state,
          });
        }

        // TODO: sendPayload if ent.userId has changed from previous entitlement
        const sendPayload = ent != null;

        if (!ackd) {
          if (!post) {
            throw new Error("acknowledgment skipped for GET");
          }
          await ackSubscription(env, purchasetoken, ent);
        }

        return r200j({
          success: true,
          message: "subscription acknowledged",
          cid: cid,
          purchaseId: test ? purchasetoken : obstoken,
          expiry: gprod.expiryDate,
          test: test,
          sku: sku,
          allProducts: productIds,
          state: state,
          developerPayload: sendPayload
            ? JSON.stringify({
                ws: await ent.toClientEntitlement(env),
              })
            : undefined,
        });
      }
    });
  } catch (err) {
    return r500j({
      error: "acknowledge failed",
      details: err.message,
      purchaseId: test ? purchasetoken : obstoken,
      cid: cid,
      sku: sku,
      allProducts: [],
      test: test,
    });
  }
}

/**
 * Consumes a Google Play one-time purchase if all conditions are met.
 * Consumption can only be triggered within 30 days before expiry, or at any
 * time after expiry provided the purchase has not already been fully consumed.
 *
 * @param {any} env - Worker environment.
 * @param {Request} req - HTTP request containing purchase token and product ID for a one-time purchase to be consumed.
 * @returns {Promise<Response>} - HTTP response indicating success or failure of the consumption.
 */
export async function googlePlayConsumePurchase(env, req) {
  let test = false;
  let purchasetoken = "";
  let obstoken = "";
  let cid = "";
  let sku = "";

  try {
    if (req.method !== "POST") {
      return r405j({ error: "method not allowed" });
    }

    purchasetoken = purchaseTokenOf(req);
    cid = cidOf(req);
    sku = skuOf(req) || stdProductId;
    test = isTest(req);

    if (emptyString(purchasetoken)) {
      return r400j({ error: "missing purchase token" });
    }
    if (emptyString(sku)) {
      return r400j({ error: "missing product id" });
    }
    if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
      return r400j({ error: "missing/invalid client id" });
    }

    // consume only applies to onetime purchases
    if (!knownOnetimeProductsAndPlans.has(sku)) {
      return r400j({
        error: "consume not applicable",
        cid: cid,
        sku: sku,
        test: test,
      });
    }

    obstoken = await obfuscate(purchasetoken);

    return await als.run(new ExecCtx(env, test, obstoken), async () => {
      const dbres = await dbx.playSub(dbx.db(env), purchasetoken);
      if (
        dbres == null ||
        !dbres.success ||
        dbres.results == null ||
        dbres.results.length <= 0
      ) {
        return r400j({
          error: "purchase not found",
          cid: cid,
          sku: sku,
          purchaseId: test ? purchasetoken : obstoken,
          test: test,
        });
      }

      const entry = dbres.results[0];
      const storedcid = entry.cid;
      // identifiers must be immutable for onetime purchases
      if (accountIdentifiersImmutable() && storedcid !== cid) {
        return r400j({
          error: "cid mismatch",
          cid: cid,
          storedCid: test ? storedcid : undefined,
          purchaseId: test ? purchasetoken : obstoken,
          sku: sku,
          test: test,
        });
      }

      const purchase2 = await getOnetimeProductV2(env, purchasetoken);
      const testPurchase = isOnetimeTest2(purchase2);
      const consumed = isOnetimeAllConsumed2(purchase2);
      const productIds = allProducts2(purchase2);
      const unconsumedProductIds = unconsumedProducts2(purchase2);
      const paid = isOnetimePaid2(purchase2);
      const pending = isOnetimeUnpaid2(purchase2);
      const cancelled = isOnetimeCancelled2(null, purchase2);
      const onetimeState = onetimePurchaseStateStr2(purchase2);

      logi(
        `onetime: ack/con ${onetimeState} for ${cid} / tok: ${obstoken} sku=${sku} ${productIds} / consumed? ${consumed} test? ${test}`,
      );

      if (testPurchase !== test) {
        return r400j({
          error: "test domain mismatch",
          purchaseId: testPurchase ? purchasetoken : obstoken,
          state: onetimeState,
          sku: sku,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          test: test,
        });
      } // else: test === testPurchase

      if (!paid || pending || cancelled) {
        return r400j({
          error: cancelled ? "purchase cancelled" : "purchase not completed",
          purchaseId: test ? purchasetoken : obstoken,
          state: onetimeState,
          sku: sku,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          test: test,
        });
      }

      // TODO: do not consume if any linked token is not consumed
      const gent = onetimePlan(purchase2);
      if (gent == null) {
        // such purchases can only be cancelled/refunded
        return r400j({
          error: "not a valid product; will be auto refunded",
          purchaseId: test ? purchasetoken : obstoken,
          cid: cid,
          state: onetimeState,
          sku: sku,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          test: test,
        });
      }

      const now = Date.now();
      const expiryMs = gent.expiry.getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const expired = now >= expiryMs;
      const withinConsumeWindow = now >= expiryMs - thirtyDaysMs; // within 30d before or after expiry

      // consume is only allowed within 30d of expiry or anytime after expiry
      // for test domain, allow consume unconditionally.
      if (!withinConsumeWindow && !test) {
        return r400j({
          error: "too early to consume",
          purchaseId: test ? purchasetoken : obstoken,
          cid: cid,
          state: onetimeState,
          sku: sku,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          expiry: gent.expiryDate,
          test: test,
        });
      }

      if (consumed) {
        logi(
          `onetime: ack/con already consumed for ${cid} / tok: ${obstoken}; test? ${test}`,
        );
        return r200j({
          success: true,
          message: "onetime purchase already consumed",
          cid: cid,
          state: onetimeState,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          purchaseId: test ? purchasetoken : obstoken,
          expiry: gent.expiryDate,
          sku: sku,
          expired: expired,
          test: test,
        });
      }

      try {
        // consuming a purchase will also ack it, if unackd
        await consumeOnetimePurchases(
          env,
          cid,
          unconsumedProductIds,
          purchasetoken,
        );
      } catch (e) {
        loge(`onetime: err consume: ${cid} / tok: ${obstoken}: ${e.message}`);
        return r500j({
          error: "failed to consume",
          details: e.message,
          purchaseId: test ? purchasetoken : obstoken,
          cid: cid,
          sku: sku,
          allProducts: productIds,
          unconsumedProducts: unconsumedProductIds,
          expiry: gent.expiryDate,
          test: test,
        });
      }

      logi(
        `onetime: ack/con done for ${cid} / tok: ${obstoken}; expired? ${expired} test? ${test}`,
      );

      return r200j({
        success: true,
        message: "onetime purchase consumed",
        cid: cid,
        state: onetimeState,
        allProducts: productIds,
        unconsumedProducts: unconsumedProductIds,
        purchaseId: test ? purchasetoken : obstoken,
        expiry: gent.expiryDate,
        sku: sku,
        test: test,
      });
    });
  } catch (err) {
    return r500j({
      error: "consume failed",
      details: err.message,
      purchaseId: test ? purchasetoken : obstoken,
      cid: cid,
      sku: sku,
      allProducts: [],
      test: test,
    });
  }
}

/**
 * Retrieves stored WSEntitlement for the requesting client.
 *
 * @param {any} env - Worker environment
 * @param {Request} req - HTTP request containing client ID
 * @returns {Promise<Response>} - HTTP response with entitlement data or error
 */
export async function googlePlayGetEntitlements(env, req) {
  try {
    // Only allow GET requests
    if (req.method !== "GET") {
      return r405j({ error: "method not allowed" });
    }

    let cid = cidOf(req);
    const test = isTest(req);
    // TODO: use vcode = url.path.get("vcode") to accept or reject purchases
    if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
      return r400j({ error: "missing/invalid client id" });
    }

    // only allow test CIDs as no check for purchase token is done here; if not test,
    // anyone with just a CID will be able to retrieve the entitlement
    if (!test) {
      return r400j({ error: "test api", cid: cid });
    }

    // TODO: only allow credential-less clients to access this endpoint
    logd(`ack: get ent for ${cid}; test? ${test}`);

    return await als.run(new ExecCtx(env, test), async () => {
      const ent = await creds(env, cid);

      if (!ent) {
        return r400j({ error: "entitlement not found", cid: cid });
      }
      if (ent.status === "banned") {
        return r400j({ error: "user banned", cid: cid });
      }
      if (ent.status === "expired") {
        // renew creds
      }

      // always send payload (test only)
      return r200j({
        success: true,
        cid: cid,
        developerPayload: JSON.stringify({
          ws: await ent.toClientEntitlement(env),
        }),
      });
    });
  } catch (err) {
    return r500j({ error: "get entitlements failed", details: err.message });
  }
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID for which to retrieve active one-time purchases
 * @param {number} limit - Max number of active purchases to retrieve; if -1, retrieves all active purchases
 * @returns {Promise<Array>} - List of active one-time purchases for the given CID
 * @throws {Error} - If there is an issue retrieving the purchases from the database
 */
async function getActiveOnetimePurchasesForCid(env, cid, limit = -1) {
  const out = await dbx.playOnetimeActive(dbx.db(env), cid, limit);
  if (out == null || !out.success) {
    return []; // no linked purchase token found
  }
  if (out.results == null || out.results.length === 0) {
    return []; // no linked purchase token found
  }
  logd(`onetime: active for cid ${cid}: ${JSON.stringify(out.results)}`);
  return out.results;
}

/**
 * Returns all fully-consumed (all productLineItems consumed) onetime purchases
 * for the given cid from the database, ordered most-recently-modified first.
 * Consumed purchases may no longer be retrievable from Google APIs (purged after
 * ~60 days) but their stored meta reflects their final state.
 * @param {any} env
 * @param {string} cid
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function getConsumedOnetimePurchasesForCid(env, cid, limit = -1) {
  const out = await dbx.playConsumedOnetimeForCid(dbx.db(env), cid, limit);
  if (out == null || !out.success) {
    return [];
  }
  if (out.results == null || out.results.length === 0) {
    return [];
  }
  logd(`onetime: consumed for cid ${cid}: ${JSON.stringify(out.results)}`);
  return out.results;
}

/**
 * Finds the most recently consumed onetime purchase for cid whose synthetic
 * expiry (start + sku duration) is still in the future.  This is the "linked"
 * purchase that conveys an active entitlement even though it has been consumed
 * by the client.
 *
 * Call this after deleting a WS entitlement for a cancelled / refunded purchase
 * to determine whether a consumed predecessor still warrants a (minimum 1-month)
 * entitlement for the cid.
 *
 * @param {any} env
 * @param {string} cid
 * @param {string} [excludeToken] - purchase token to skip (the cancelled/refunded one)
 * @returns {Promise<GEntitlement|null>}
 */
async function activeConsumedOnetimePlan(env, cid, excludeToken = null) {
  const rows = await getConsumedOnetimePurchasesForCid(env, cid);
  for (const row of rows) {
    if (!emptyString(excludeToken) && row.purchasetoken === excludeToken) {
      continue;
    }
    const metaRaw = row.meta || null;
    if (metaRaw == null) continue;
    try {
      const metaParsed =
        typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw;
      if (metaParsed?.kind !== "androidpublisher#productPurchaseV2") continue;
      // TODO: attempt to fetch latest state from Google?
      const p2 = new ProductPurchaseV2(metaParsed);
      const plan = onetimePlan(p2, /*mustBeAckd*/ true);
      if (plan == null) continue;
      if (plan.expiry == null || plan.expiry.getTime() <= Date.now()) {
        logd(
          `onetime: consumed linked purchase expired at ${plan.expiry} for ${cid}`,
        );
        continue;
      }
      logi(
        `onetime: consumed linked purchase with future expiry ${plan.expiry} found for ${cid} / tok: ${row.purchasetoken}`,
      );
      // TODO: explictly return plan that expires late (db rows are mtime ordered)?
      return plan;
    } catch (err) {
      loge(`onetime: err parsing consumed meta for ${cid}: ${err.message}`);
    }
  }
  return null;
}

/**
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID for which to find linked one-time purchase
 * @param {string} purchasetoken - Purchase token of the current one-time purchase being processed
 * @param {string?} linkedtoken - Optional purchase token linked to the current purchase token in the database (may be an obsolete/deleted token)
 * @return {Promise<[string?, ProductPurchaseV2?]>} - List of the first linked one-time active purchase
 * (purchase token and metadata) for the given cid, excluding the current purchase token.
 * Considers both unconsumed (actively purchased) and consumed (previously active, expiry still
 * in the future) purchases, since a consumed purchase can serve as a valid linked predecessor.
 * @throw {Error} - If there is an issue retrieving the purchases from the database or if there are more than 2 active purchases for the CID
 */
async function linkedOnetimePurchases2(
  env,
  cid,
  purchasetoken,
  linkedtoken = null,
) {
  const nolink = [null, null];
  if (emptyString(cid) || emptyString(purchasetoken)) {
    return nolink;
  }

  const limit = 2; // link up to 2 purchases incl. fn arg "purchasetoken"
  // Gather unconsumed (traditionally "active") purchases and consumed purchases
  // with future expiry (linked predecessors).  Unconsumed take precedence.
  const [activePurchases, consumedPurchases] = await Promise.all([
    getActiveOnetimePurchasesForCid(env, cid),
    getConsumedOnetimePurchasesForCid(env, cid),
  ]);

  // Merge: unconsumed first, then consumed; deduplicate by purchasetoken.
  const seen = new Set();
  const allPurchases = [];
  for (const p of [...activePurchases, ...consumedPurchases]) {
    if (!seen.has(p.purchasetoken)) {
      seen.add(p.purchasetoken);
      allPurchases.push(p);
    }
  }

  // purchases other than the one being registered right now.
  const others = allPurchases.filter((p) => p.purchasetoken !== purchasetoken);

  if (others.length > limit) {
    throw new Error(`too many active purchases for ${cid}: ${others.length}`);
  }

  if (consumedPurchases.length === 0) {
    log.d(`linkedOnetimePurchases2: no active or consumed for ${cid}`);
    return nolink;
  }

  // prefer an explicit linkedtoken match if provided.
  for (const p of others) {
    const meta = typeof p.meta === "string" ? JSON.parse(p.meta) : p.meta;
    if (linkedtoken != null && p.purchasetoken === linkedtoken) {
      return [p.purchasetoken, new ProductPurchaseV2(meta)];
    }
  }

  // fallback to the first other purchase (most-recently modified due to ORDER BY mtime DESC).
  if (others.length > 0) {
    const p = others[0];
    const meta = typeof p.meta === "string" ? JSON.parse(p.meta) : p.meta;
    return [p.purchasetoken, new ProductPurchaseV2(meta)];
  }

  return nolink;
}

/**
 * @param {any} env
 * @param {SubscriptionPurchaseV2} sub
 * @returns {Promise<string|null>}
 * @throws {Error} - If the CID cannot be retrieved or generated.
 */
async function getCidThenPersist(env, sub) {
  const gen = true;
  const persist = true;
  return getOrGenAndPersistCid(env, sub, !gen, persist);
}

async function getCid(env, sub) {
  const gen = true;
  const persist = true;
  return getOrGenAndPersistCid(env, sub, !gen, !persist);
}

/**
 * @param {any} env
 * @param {ProductPurchaseV2|ProductPurchaseV1} purchase
 * @returns {Promise<string|null>}
 */
async function getCidThenPersistProduct(env, purchase) {
  return getOrGenAndPersistCidFromProduct(
    env,
    purchase,
    /*do not generate */ false,
    /*persist to db*/ true,
  );
}

/**
 * @param {any} env
 * @param {ProductPurchaseV2|ProductPurchaseV1} purchase
 * @returns {Promise<string|null>}
 */
async function getCidProduct(env, purchase) {
  return getOrGenAndPersistCidFromProduct(
    env,
    purchase,
    /*do not generate */ false,
    /*do not persist */ false,
  );
}

/**
 * @param {any} env
 * @param {SubscriptionPurchaseV2} sub
 * @param {boolean} gen - Whether to generate a new CID if it cannot be retrieved.
 * That is, if gen is true, client must refuse to acknowledge subs with missing
 * obfuscated external account ID (cid).
 * @param {boolean} insert - Whether to insert the CID into the database.
 * @returns {Promise<string|null>}
 * @throws {Error} - If the CID cannot be retrieved or generated.
 */
async function getOrGenAndPersistCid(env, sub, gen = true, insert = true) {
  const db = dbx.db(env);
  let cid = "";
  let msg = "";
  let kind = 0; // 0 play client, 1 generated, 2 stripe
  try {
    cid = await recursivelyGetCid(env, sub);
  } catch (e) {
    msg = e.message;
    // If we can't get the CID, generate a new one
    logi(`sub: no cid: ${msg}, may be gen new...`);
  }
  if (!cid || cid.length < mincidlength) {
    cid = crandHex(64);
    kind = 1; // generated
  }
  if (kind == 1 && !gen) {
    throw new Error("sub: missing cid for purchase: err? " + msg);
  }
  if (insert) {
    const clientinfo = sub.subscribeWithGoogleInfo;
    const out = await dbx.insertClient(db, cid, clientinfo, kind);
    if (out == null || !out.success) {
      throw new Error(`sub: failed to get or insert ${cid}`);
    }
  }
  return cid; // all okay
}

/**
 * @param {any} env
 * @param {ProductPurchaseV2|ProductPurchaseV1} purchase
 * @param {boolean} gen
 * @param {boolean} insert
 * @returns {Promise<string|null>}
 */
async function getOrGenAndPersistCidFromProduct(
  env,
  purchase,
  gen = true,
  insert = true,
) {
  let kind = 0; // 0 play client, 1 generated, 2 stripe
  let cid = purchase.obfuscatedExternalAccountId;

  if (!cid || cid.length < mincidlength) {
    cid = crandHex(64);
    kind = 1; // generated
  }
  if (kind == 1 && !gen) {
    throw new Error("onetime: cid missing; discarding purchase");
  }
  if (insert) {
    const out = await dbx.insertClient(dbx.db(env), cid, null, kind);
    if (out == null || !out.success) {
      throw new Error(`onetime: db err; purchase by ${cid} failed`);
    }
  }
  return cid; // all okay
}

/**
 * @param {any} env
 * @param {string} cid - Client ID, usually the obfuscatedExternalAccountId.
 * @param {string} pt - Purchase token.
 * @param {SubscriptionPurchaseV2} sub - The subscription purchase object.
 * @param {Promise<dbx.D1Out>} out - The result of db op.
 */
async function registerOrUpdateActiveSubscription(env, cid, pt, sub) {
  // TODO: cid must match with existing db entry, if any
  // linkedPurchaseToken is the older token this new pt must "invalidate" / supercede
  return dbx.upsertPlaySub(dbx.db(env), cid, pt, sub.linkedPurchaseToken, sub);
}

/**
 * Refetches the purchase from Google and updates the database, retrying once on failure.
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID associated with the purchase
 * @param {string} pt - Purchase token of the subscription purchase to refresh
 * @param {boolean} bg - Whether this refresh is happening in the background (e.g., after a consume) or foreground (e.g., during ack)
 * @returns {Promise<boolean>}
 * @throws {Error} - If the purchase cannot be refreshed after retries
 */
async function refreshDatabaseState(env, cid, pt) {
  // TODO: use d.go?
  const obs = obsToken();
  const errs = [];
  for (const tries of [1, 10]) {
    await sleep(tries);
    try {
      const updated = await getOnetimeProductV2(env, pt);
      await registerOrUpdateOnetimePurchase(env, cid, pt, updated);
      logi(`onetime: post consume update ok ${obs} for ${cid}`);
      return true;
    } catch (err) {
      errs.push(err);
      logw(err);
    }
  }
  const msg = errs.map((e) => e.message).join("; ");
  loge(`refresh: err ${cid} / ${obs}: ${msg}`);
  return false;
}

/**
 * Links purchases, if needed.
 * @param {any} env
 * @param {string} cid
 * @param {string} purchasetoken
 * @param {ProductPurchaseV2|ProductPurchaseV1} purchasemeta
 * @param {string?} linkedtoken
 * @returns {Promise<dbx.D1Out>}
 */
async function registerOrUpdateOnetimePurchase(
  env,
  cid,
  purchasetoken,
  purchasemeta,
  linkedtoken = null,
) {
  const nolinktoken = null;
  if (!emptyString(linkedtoken)) {
    const lobs = await obfuscate(linkedtoken);
    // cid for linkedtoken if supplied must match with existing db entry, if any
    const dbres = await dbx.playSub(dbx.db(env), linkedtoken);
    if (
      dbres == null ||
      !dbres.success ||
      dbres.results == null ||
      dbres.results.length <= 0
    ) {
      throw new Error(`linked token ${lobs} not found for ${cid}`);
    }
    const linkedentry = dbres.results[0];
    const linkedcid = linkedentry.cid;
    if (accountIdentifiersImmutable() && linkedcid !== cid) {
      loge(
        `onetime: register: linked token ${lobs} cid ${linkedcid} != ${cid}`,
      );
      throw new Error(`mismatch: linked cid != ${cid}`);
    }
  }

  return dbx.upsertPlaySub(
    dbx.db(env),
    cid,
    purchasetoken,
    linkedtoken || nolinktoken,
    purchasemeta,
  );
}

/**
 * @param {any} env
 * @param {SubscriptionPurchaseV2} sub
 * @returns {Promise<string>} - The CID of the subscription.
 * @throws {Error} - If the CID cannot be retrieved.
 */
async function recursivelyGetCid(env, sub, n = 1) {
  const cid = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  let cidlen = 0;
  if (cid && cid.length) {
    cidlen = cid.length;
  }
  if (cidlen >= mincidlength) {
    return cid;
  }
  if (cidlen == 0 && n < 4 && sub.linkedPurchaseToken) {
    // If linkedPurchaseToken is present, try to get the subscription again
    return await recursivelyGetCid(
      env,
      await getSubscription(env, sub.linkedPurchaseToken),
      n + 1,
    );
  }
  throw new Error(
    `Cid ${cid} (${cidlen} ${n}) missing or invalid for profile ${sub.subscribeWithGoogleInfo?.profileId ?? "unknown"}, ${sub.regionCode}, ${sub.startTime}`,
  );
}

/**
 * @param {SubscriptionPurchaseV2} sub
 * @returns {GEntitlement|null} The expiry date and product ID of the subscription.
 * @throws {Error} - If the subscription line items are invalid.
 */
function subscriptionInfo(sub) {
  if (!sub || !sub.lineItems || sub.lineItems.length === 0) {
    throw new Error("fatal: no sub line items in purchase");
  }
  const start = sub.startTime ? new Date(sub.startTime) : null;
  for (const item of sub.lineItems) {
    // multiple line items for deferred upgrades/downgrades
    // developer.android.com/google/play/billing/subscriptions#handle-deferred-replacement
    // const deferringAnotherItem = item.deferredItemReplacement != null;
    // deferred line items do not have expiry time set
    const deferred = emptyString(item.expiryTime);
    if (deferred) continue; // no-op
    // TODO: match incoming purchasetoken with orderid?
    const s = subscriptionItem2plan(item, start);
    if (s != null) return s;
    // else try next line item
  }
  return null; // no valid line items found
}

/**
 * @param {SubscriptionLineItem} item
 * @param {Date|null} start
 * @return {GEntitlement|null} - The entitlement based on the product ID.
 */
function subscriptionItem2plan(item, start) {
  const productId = item.productId;
  if (!knownProducts.has(productId)) {
    return null; // unknown product
  }
  // expiryTime is in RFC3339 format:
  // "2014-10-02T15:01:23Z", "2014-10-02T15:01:23.045123456Z", or "2014-10-02T15:01:23+05:30".
  const until = item.expiryTime ? new Date(item.expiryTime) : null;
  if (productId === monthlyProxyProductId) {
    return GEntitlement.monthly(productId, start, until);
  } else if (productId === annualProxyProductId) {
    return GEntitlement.yearly(productId, start, until);
  }
  if (item.offerDetails == null || !item.offerDetails.basePlanId) {
    return null; // no base plan
  }
  const baseplan = item.offerDetails.basePlanId;
  const ent = knownBasePlans.get(baseplan);
  if (ent == null) {
    return null; // unknown base plan
  }
  return GEntitlement.until(ent, start, until);
}

/**
 * TODO: instead of null throw Error with approp msg
 * @param {ProductPurchaseV2} p - existing purchase to extend, or new purchase if linkedPurchase is null.
 * @param {ProductPurchaseV2?} linkedPurchase - Adds expiry to existing purchase.
 * @param {boolean} mustBeAckd - if true, return null if purchase is not acknowledged
 * @returns {GEntitlement?} - If p is valid, else null.
 */
function onetimeDeferredPlan(p, linkedPurchase = null, mustBeAckd = false) {
  if (linkedPurchase == null) {
    logw(`onetime: deferred: null linked purchase`);
    return onetimePlan(p, mustBeAckd);
  }

  const existingPlan = onetimePlan(linkedPurchase, mustBeAckd);
  if (existingPlan == null) {
    loge(`onetime: deferred: no plan for linked purchase`);
    if (log.debug) logo(linkedPurchase);
    return null;
  }

  const newPlan = onetimePlan(p, mustBeAckd);
  if (newPlan == null) {
    loge(`onetime: deferred: no plan for new purchase`);
    if (log.debug) logo(p);
    return null;
  }

  const newStart =
    newPlan.start instanceof Date ? newPlan.start.getTime() : NaN;
  const newExpiry =
    newPlan.expiry instanceof Date ? newPlan.expiry.getTime() : NaN;
  const existingExpiry =
    existingPlan.expiry instanceof Date ? existingPlan.expiry.getTime() : NaN;

  if (
    Number.isNaN(newStart) ||
    newStart <= 0 ||
    Number.isNaN(newExpiry) ||
    newExpiry <= 0 ||
    Number.isNaN(existingExpiry) ||
    existingExpiry <= 0
  ) {
    loge(`onetime: deferred: missing start or expiry`);
    if (log.debug) {
      logo(p);
      logo(linkedPurchase);
    }
    return null;
  }

  const newUntil =
    (existingExpiry > newStart ? existingExpiry : newStart) +
    (newExpiry - newStart);

  logi(
    `onetime: deferred: expiry ${new Date(existingExpiry)} => ${new Date(newUntil)}`,
  );

  // expiry of old plan is extended until start of new plan
  return GEntitlement.until(newPlan, newPlan.start, new Date(newUntil));
}

/**
 * TODO: instead of null throw Error with approp msg
 * @param {ProductPurchaseV2} p
 * @param {boolean} mustBeAckd - if true, return null if purchase is not acknowledged
 * @returns {GEntitlement?} - If p is valid, else null.
 */
function onetimePlan(p, mustBeAckd = false) {
  if (p == null) {
    loge(`onetime: invalid product purchase ${p}`);
    return null;
  }

  const test = isOnetimeTest2(p);
  // TODO: test if ackd and consumed?
  const products = p.productLineItem;
  if (!Array.isArray(products) || products.length === 0) {
    loge(`onetime: no product line items ${p}; test? ${test}`);
    return null;
  }

  if (mustBeAckd && !isOnetimeAck2(p)) {
    loge(`onetime: purchase not acknowledged ${p}; test? ${test}`);
    return null;
  }

  for (const item of products) {
    if (!knownProducts.has(item.productId)) {
      loge(
        `onetime: unknown sku / product id ${item.productId}; test? ${test}`,
      );
      continue; // unknown product
    }
    // purchaseOptionId is the "baseplan" equivalent for onetime products
    const baseplan = item.productOfferDetails?.purchaseOptionId;
    const start = p.purchaseCompletionTime
      ? new Date(p.purchaseCompletionTime)
      : null;
    if (
      emptyString(baseplan) ||
      start == null ||
      Number.isNaN(start.getTime())
    ) {
      loge(
        `onetime: missing baseplan or start time; ${item.productId}; test? ${test}`,
      );
      continue; // no base plan or start time
    }
    let ent = knownBasePlans.get(baseplan);
    if (ent == null) {
      loge(
        `onetime: unknown baseplan ${baseplan} for ${item.productId}; test? ${test}`,
      );
      continue; // unknown base plan
    }
    ent = GEntitlement.since(ent, start);
    logd(
      `onetime: found plan ${baseplan} for ${item.productId}; test? ${test}`,
    );
    return ent;
  }

  loge(
    `onetime: no valid items; ${p.orderId} ${p.obfuscatedExternalAccountId} test? ${test}`,
  );
  return null;
}

/**
 * ryan-schachte.com/blog/oauth_cloudflare_workers / archive.vn/B3FYC
 * @param {string} creds - principal
 * @returns {Promise<string>} - The Google OAuth access token.
 * @throws {Error} - If the token cannot be retrieved.
 */
async function gtoken(creds) {
  if (!creds) {
    throw new Error("gtoken: missing credentials");
  }
  const key = JSON.parse(creds);
  const cacheKey = key.client_email;

  if (!cacheKey) {
    throw new Error("gtoken: missing client_email in credentials");
  }

  const safetyMarginMs = 1 * 60 * 1000; // 1m
  // Check if we have a valid cached token
  const cached = gtokenCache.get(cacheKey);
  if (cached && cached.token && cached.expiry > Date.now() + safetyMarginMs) {
    logd(`gtoken: cached; expires ${new Date(cached.expiry)}`);
    return cached.token;
  }

  const g = await getGoogleAuthToken(
    key.client_email,
    key.private_key || null,
    androidscope,
  );

  if (g != null && g.token) {
    gtokenCache.set(cacheKey, g);
    logd(`gtoken: new; expires at ${new Date(g.expiry)}`);
    return g.token;
  }

  throw new Error("gtoken: could not generate");
}

/**
 * @param {SubscriptionNotification} notif - The notification object.
 */
function notificationTypeStr(notif) {
  const no = notif.notificationType;
  switch (no) {
    case 1:
      return "RECOVERED";
    case 2:
      return "RENEWED";
    case 3:
      return "CANCELED";
    case 4:
      return "PURCHASED";
    case 5:
      return "ON_HOLD";
    case 6:
      return "IN_GRACE_PERIOD";
    case 7:
      return "RESTARTED";
    case 8:
      return "PRICE_CHANGE_CONFIRMED";
    case 9:
      return "DEFERRED";
    case 10:
      return "PAUSED";
    case 11:
      return "PAUSE_SCHEDULE_CHANGED";
    case 12:
      return "REVOKED";
    case 13:
      return "EXPIRED";
    case 19:
      return "PRICE_CHANGE_UPDATED";
    case 20:
      return "PENDING_PURCHASE_CANCELED";
    default:
      return "UNKNOWN_" + no;
  }
}

/**
 * @param {OneTimeProductNotification} notif
 */
function onetimeNotificationTypeStr(notif) {
  const no = notif.notificationType;
  switch (no) {
    case 1:
      return "PURCHASED";
    case 2:
      return "CANCELED";
    default:
      return "UNKNOWN_" + no;
  }
}

/**
 * @param {ProductPurchaseV1} purchase
 * @returns {boolean}
 */
function isOnetimeAck(purchase) {
  return purchase.acknowledgementState === 1;
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimeAck2(purchase2) {
  return (
    purchase2.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
  );
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {string[]} list of productIds (may return [undefined, undefined, ...])
 */
function allProducts2(purchase2) {
  return (
    purchase2.productLineItem
      ?.map((item) => item.productId)
      .filter((id) => id != null) ?? []
  );
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {string[]} list of unconsumed productIds
 */
function unconsumedProducts2(purchase2) {
  return (
    purchase2.productLineItem
      ?.filter(
        (p) =>
          p != null &&
          p.productOfferDetails != null &&
          p.productOfferDetails.consumptionState !==
            "CONSUMPTION_STATE_CONSUMED",
      )
      ?.map((p) => p.productId) || []
  );
}

/**
 * @param {ProductPurchaseV2} purchase2
 */
function isOnetimeAllConsumed2(purchase2) {
  const p = purchase2.productLineItem;
  if (p == null || p.length === 0) {
    return true; // nothing to consume, so all consumed
  }
  return (
    p.filter(
      (it) =>
        it != null &&
        it.productOfferDetails != null &&
        it.productOfferDetails.consumptionState !==
          "CONSUMPTION_STATE_CONSUMED",
    ).length === 0
  );
}

/**
 * @param {ProductPurchaseV1} purchase
 * @returns {boolean}
 */
function isOnetimePaid(purchase) {
  return purchase.purchaseState === 0;
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimePaid2(purchase2) {
  return purchase2.purchaseStateContext?.purchaseState === "PURCHASED";
}

/**
 * @param {ProductPurchaseV1} purchase
 * @returns {boolean}
 */
function isOnetimeUnpaid(purchase) {
  return purchase.purchaseState === 2;
}

/**
 *
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimeUnpaid2(purchase2) {
  return purchase2.purchaseStateContext?.purchaseState === "PENDING";
}

/**
 * @param {OneTimeProductNotification} notif
 * @param {ProductPurchaseV1} purchase
 * @returns {boolean}
 */
function isOnetimeCancelled(notif, purchase) {
  return notif.notificationType === 2 || purchase.purchaseState === 1;
}

/**
 * @param {OneTimeProductNotification?} notif
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimeCancelled2(notif, purchase2) {
  return (
    (notif != null && notif.notificationType === 2) ||
    (purchase2 != null &&
      purchase2.purchaseStateContext != null &&
      purchase2.purchaseStateContext.purchaseState === "CANCELLED")
  );
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimeRefunded2(purchase2) {
  return purchase2.productLineItem.some(
    (item) =>
      item != null &&
      item.productOfferDetails != null &&
      (item.productOfferDetails.refundableQuantity === 0 || // fully refunded
        item.productOfferDetails.quantity !==
          item.productOfferDetails.refundableQuantity), // partially refunded
  );
}

/**
 * @param {ProductPurchaseV2} purchase2
 * @returns {boolean}
 */
function isOnetimeFullyRefunded2(purchase2) {
  return purchase2.productLineItem.every(
    (item) => item.productOfferDetails?.refundableQuantity === 0,
  );
}

/**
 * @param {ProductPurchaseV1} purchase
 * @returns {boolean}
 */
function isOnetimeTest(purchase) {
  return purchase.purchaseType === 0;
}

/**
 * @param {ProductPurchaseV2} purchase
 * @returns {boolean}
 */
function isOnetimeTest2(purchase) {
  return purchase.testPurchaseContext?.fopType === "TEST";
}

/**
 *
 * @param {ProductPurchaseV2} purchase2
 * @returns {"PURCHASED"|"CANCELED"|"PENDING"|string}
 */
function onetimePurchaseStateStr2(purchase2) {
  const ack = purchase2.acknowledgementState;
  const ps = purchase2.purchaseStateContext?.purchaseState || "";
  return `${ps}|${ack}`;
}

/**
 * @param {SubscriptionPurchaseV2} sub
 * @returns {string[]} list of productIds in the subscription line items
 */
function subAllProducts(sub) {
  return (
    sub.lineItems?.map((item) => item.productId).filter((id) => id != null) ??
    []
  );
}

/**
 * @param {any} env - Workers environment.
 * @param {string} t - purchase token.
 */
async function isLinkedPurchaseToken(env, t) {
  const out = await dbx.firstLinkedPurchaseTokenEntry(dbx.db(env), t);
  if (out == null || !out.success) {
    return false; // no linked purchase token found
  }
  if (out.results == null || out.results.length === 0) {
    return false; // no linked purchase token found
  }
  logi(`tok: is linked? ${obsToken()}: ${JSON.stringify(out.results)}`);
  return out.results.length > 0;
}

/**
 * @param {SubscriptionPurchaseV2} sub1
 * @param {SubscriptionPurchaseV2} sub2
 * @param {boolean} strict - If set, also compares startTime, productId, orderId, regionCode.
 * @returns {boolean} - Whether the purchase tokens are equal.
 */
function subscriptionsMoreOrLessEqual(sub1, sub2, strict = false) {
  if (sub1 == null || sub2 == null) return false;
  // check if sub1 and sub2 are equal in most ways
  if (
    accountIdentifiersImmutable() &&
    sub1.externalAccountIdentifiers.obfuscatedExternalAccountId !==
      sub2.externalAccountIdentifiers.obfuscatedExternalAccountId
  ) {
    return false;
  }
  if ((sub1.testPurchase != null) !== (sub2.testPurchase != null)) return false;

  if (strict) {
    if (sub1.startTime !== sub2.startTime) return false;
    if (sub1.regionCode !== sub2.regionCode) return false;
    for (const item1 of sub1.lineItems) {
      let foundProduct = false;
      let foundOrder = false;
      for (const item2 of sub2.lineItems) {
        if (item1.latestSuccessfulOrderId === item2.latestSuccessfulOrderId) {
          foundOrder = true;
          break;
        }
        if (item1.productId === item2.productId) {
          foundProduct = true;
          break;
        }
      }
      if (!foundProduct || !foundOrder) return false;
    }
  }
  return true;
}

/**
 * @param {SubscriptionPurchaseV2} sub
 * @returns {boolean} - Whether the subscription is being replaced or not.
 */
function replacing(sub) {
  const ctx = sub.canceledStateContext;
  if (ctx == null) return false;
  return ctx.replacementCancellation != null;
}

/**
 * GET g/tx?cid=&purchaseToken=[&test][&tot=n][&active]
 *
 * Returns the playorders row for the given purchaseToken (with meta parsed as
 * a JS object).  Additionally:
 *
 * - If `tot=n` (1–20) is present the response also includes up to `n` most
 *   recent purchases for the same cid (ordered by mtime desc), provided the
 *   given purchaseToken exists in the database.  The entry for the sent
 *   purchaseToken is always included in the list.
 *
 * - If `active` is present the behaviour changes to: return all active
 *   purchases (up to `tot=n`, or just the single row when `tot` is absent),
 *   but only if the sent purchaseToken itself is active.
 *
 * @param {any} env - Worker environment
 * @param {Request} req - HTTP request
 * @returns {Promise<Response>}
 */
export async function googlePlayGetTransaction(env, req) {
  try {
    if (req.method !== "GET") {
      return r405j({ error: "method not allowed" });
    }

    const cid = cidOf(req);
    const purchaseToken = purchaseTokenOf(req);
    const test = isTest(req);
    const activeOnly = activeOnlyOf(req);
    const totParam = totOf(req);
    let tot = totParam != null ? parseInt(totParam, 10) : 0;
    if (isNaN(tot) || tot < 1) {
      tot = 0; // 0 means "only return the single row for purchaseToken"
    } else if (tot > 20) {
      tot = 20;
    }

    if (!cid || cid.length < mincidlength || !/^[a-fA-F0-9]+$/.test(cid)) {
      return r400j({ error: "missing/invalid client id" });
    }
    if (emptyString(purchaseToken)) {
      return r400j({ error: "missing purchase token" });
    }

    const obstoken = await obfuscate(purchaseToken);
    logd(
      `tx: cid=${cid} tok=${obstoken} tot=${tot} active=${activeOnly} test=${test}`,
    );

    return await als.run(new ExecCtx(env, test, obstoken), async () => {
      // look up the requested purchase token
      const tokenRes = await dbx.playSub(dbx.db(env), purchaseToken);
      if (
        tokenRes == null ||
        !tokenRes.success ||
        tokenRes.results == null ||
        tokenRes.results.length === 0
      ) {
        return r400j({
          error: "purchase token not found",
          purchaseId: obstoken,
          cid: cid,
          test: test,
        });
      }

      const entry = tokenRes.results[0];
      // verify the token belongs to the claimed cid
      if (entry.cid !== cid) {
        return r400j({
          error: "cid mismatch",
          purchaseId: obstoken,
          cid: cid,
          test: test,
        });
      }

      // parse the meta field of a single row into a JS object
      function parseRow(row) {
        if (row == null) return row;
        const out = Object.assign({}, row);
        if (typeof out.meta === "string") {
          try {
            out.meta = JSON.parse(out.meta);
          } catch (_) {
            // leave as string if unparseable
          }
        }
        return out;
      }

      /**
       * is a parsed row considered "active"?
       * @param {*} row - a playorders row with meta parsed as a JS object
       * @returns {boolean} - true if the row is active, false otherwise
       */
      function isRowActive(row) {
        /** @type {ProductPurchaseV2} */
        const m = row.meta;
        if (m == null || typeof m !== "object") return false;
        if (
          m.kind === "androidpublisher#subscriptionPurchaseV2" &&
          m.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE"
        ) {
          return true;
        }
        if (
          m.kind === "androidpublisher#productPurchaseV2" &&
          m.purchaseStateContext != null &&
          m.purchaseStateContext.purchaseState === "PURCHASED"
        ) {
          return true;
        }
        return false;
      }

      const parsedEntry = parseRow(entry);

      if (!activeOnly && tot === 0) {
        // simplest case: just return the single row
        return r200j({
          success: true,
          cid: cid,
          purchaseId: obstoken,
          tx: parsedEntry,
          test: test,
        });
      }

      if (activeOnly) {
        // only proceed if the sent purchaseToken is itself active
        if (!isRowActive(parsedEntry)) {
          return r400j({
            error: "purchase token is not active",
            purchaseId: obstoken,
            cid: cid,
            test: test,
          });
        }

        if (tot === 0) {
          // just the single active row
          return r200j({
            success: true,
            cid: cid,
            purchaseId: obstoken,
            tx: [parsedEntry],
            test: test,
          });
        }

        // return up to tot active rows for this cid
        const activeRes = await dbx.playActiveByCid(dbx.db(env), cid, tot);
        const activeRows =
          activeRes != null && activeRes.success && activeRes.results != null
            ? activeRes.results.map(parseRow)
            : [parsedEntry];

        // ensure the requested purchaseToken is always included
        const hasActiveToken = activeRows.some(
          (row) => row.purchasetoken === purchaseToken,
        );
        const txActive = hasActiveToken
          ? activeRows
          : [parsedEntry, ...activeRows].slice(0, tot);

        return r200j({
          success: true,
          cid: cid,
          purchaseId: obstoken,
          tx: txActive,
          test: test,
        });
      }

      // tot > 0, no activeOnly: return up to `tot` past/active rows for this cid
      const histRes = await dbx.playByCid(dbx.db(env), cid, tot);
      const histRows =
        histRes != null && histRes.success && histRes.results != null
          ? histRes.results.map(parseRow)
          : [parsedEntry];

      // ensure the requested purchaseToken is always included
      const hasHistToken = histRows.some(
        (row) => row.purchasetoken === purchaseToken,
      );
      const txHist = hasHistToken
        ? histRows
        : [parsedEntry, ...histRows].slice(0, tot);

      return r200j({
        success: true,
        cid: cid,
        purchaseId: obstoken,
        tx: txHist,
        test: test,
      });
    });
  } catch (err) {
    return r500j({ error: "get transaction failed", details: err.message });
  }
}

function logi(...args) {
  log.i(...args);
}

function logw(...args) {
  log.w(...args);
}

function loge(...args) {
  log.e(...args);
}

function logd(...args) {
  log.d(...args);
}

function logo(obj) {
  log.o(obj);
}

/**
 * @param {Response} r - Fetch response object.
 * @returns {Promise<string>} - Error message from the response, or an empty string if no error.
 */
async function gerror(r) {
  try {
    // {
    // "error": {
    //     "code": 401,
    //     "message": "The current user has insufficient permissions to perform the requested operation.",
    //     "errors": [
    //     {
    //         "message": "The current user has insufficient permissions to perform the requested operation.",
    //         "domain": "androidpublisher",
    //         "reason": "permissionDenied"
    //     }
    //     ]
    // }
    // }
    const msg = await consumejson(r);
    if (msg == null || typeof msg !== "object") {
      return "unknown msg: " + msg;
    }
    loge(`gerror: ${JSON.stringify(msg)}`);
    if (msg.error && msg.error.message) {
      return msg.error.message;
    }
    return msg;
  } catch (e) {
    // If JSON parsing fails, return the response text
    return `err getting gerr: ${e.message}, code: ${r.status}`;
  }
}

async function sleep(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}
