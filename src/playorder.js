/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import GoogleAuth from "cloudflare-workers-and-google-oauth";
import { als, ExecCtx } from "./d.js";
import * as dbx from "./sql/dbx.js";
import { crandHex } from "./webcrypto.js";
import {
  creds,
  deleteWsEntitlement,
  getOrGenWsEntitlement,
  WSEntitlement,
} from "./wsent.js";

// developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
const androidscope = ["https://www.googleapis.com/auth/androidpublisher"];
const packageName = "com.celzero.bravedns";
const subsv2 = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptionsv2/tokens/`;
// subscriptionId isn't required since May 21, 2025
// ref: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge
// but: github.com/googleapis/google-api-go-client/blob/971a6f113/androidpublisher/v3/androidpublisher-gen.go#L19539
const ack = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/`;
const tokenp = "/tokens/";
const acksuffix = ":acknowledge";
// see: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/revoke
const revoke = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptions/`;
const revokesuffix = ":revoke";

const monthlyProxyProductId = "proxy_monthly_subscription_test";
const annualProxyProductId = "proxy_annual_subscription_test";

// if true, NEVER acknowledge sub payments without an entitlement
const donotAckWithoutEntitlement = true;
const mincidlength = 32; // ideally 64 hex chars

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
    this.attribues = json.message.attributes || {};
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

/*
{
  "version": string,
  "packageName": string,
  "eventTimeMillis": long,
  "oneTimeProductNotification": OneTimeProductNotification,
  "subscriptionNotification": SubscriptionNotification,
  "voidedPurchaseNotification": VoidedPurchaseNotification,
  "testNotification": TestNotification
}
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

/*
{
  "version": string,
  "notificationType": int,
  "purchaseToken": string,
  "sku": string
}
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

/*
{
  "version": string,
  "notificationType": int,
  "purchaseToken": string
}
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
     * (7) SUBSCRIPTION_RESTARTED - User has restored their subscription from Play > Account > Subscriptions. The subscription was canceled but had not expired yet when the user restores. For more information, see Restorations.
     * (8) SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (DEPRECATED) - A subscription price change has successfully been confirmed by the user.
     * (9) SUBSCRIPTION_DEFERRED - A subscription's recurrence time has been extended.
     * (10) SUBSCRIPTION_PAUSED - A subscription has been paused.
     * (11) SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED - A subscription pause schedule has been changed.
     * (12) SUBSCRIPTION_REVOKED - A subscription has been revoked from the user before the expiration time.
     * (13) SUBSCRIPTION_EXPIRED - A subscription has expired.
     * (20) SUBSCRIPTION_PENDING_PURCHASE_CANCELED - A pending transaction of a subscription has been canceled.
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

/*
  {
    "purchaseToken":"PURCHASE_TOKEN",
    "orderId":"GS.0000-0000-0000",
    "productType":1
    "refundType":1
  }
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

/*
{
  "version": string
}
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

/*
{
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
    "obfuscatedExternalAccountId": " obfuscated-acc-id-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
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
     * @type {CanceledStateContext} - Canceled state context, if any.
     */
    this.canceledStateContext = json.canceledStateContext
      ? new CanceledStateContext(json.canceledStateContext)
      : null;
    /**
     * @type {TestPurchase} - Test purchase information, if any.
     */
    this.testPurchase = json.testPurchase ? new TestPurchase(json) : null;
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

/*
{
  "autoResumeTime": string
}
*/
class PausedStateContext {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The time at which the subscription will automatically resume, in RFC3339 format.
     */
    this.autoResumeTime = json.autoResumeTime || "";
  }
}

/*
Union field cancellation_reason can be only one of the following:
  {
  "userInitiatedCancellation": {
    object (UserInitiatedCancellation)
  },
  "systemInitiatedCancellation": {
    object (SystemInitiatedCancellation)
  },
  "developerInitiatedCancellation": {
    object (DeveloperInitiatedCancellation)
  },
  "replacementCancellation": {
    object (ReplacementCancellation)
  }
}
*/
/*
Union field cancellation_reason can be only one of the following:
  {
  "userInitiatedCancellation": {
    object (UserInitiatedCancellation)
  },
  "systemInitiatedCancellation": {
    object (SystemInitiatedCancellation)
  },
  "developerInitiatedCancellation": {
    object (DeveloperInitiatedCancellation)
  },
  "replacementCancellation": {
    object (ReplacementCancellation)
  }
}
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

/*
{
  "cancelSurveyResult": {
    object (CancelSurveyResult)
  },
  "cancelTime": string
}
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

/*
{
  "reason": enum (CancelSurveyReason),
  "reasonUserInput": string
}
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

/*
{
  "externalAccountId": string,
  "obfuscatedExternalAccountId": string,
  "obfuscatedExternalProfileId": string
}
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

/*
{
  "profileId": string,
  "profileName": string,
  "emailAddress": string,
  "givenName": string,
  "familyName": string
}
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

/*
{
  "productId": string,
  "expiryTime": string,
  "latestSuccessfulOrderId": string,

  // Union field plan_type can be only one of the following:
  "autoRenewingPlan": {
    object (AutoRenewingPlan)
  },
  "prepaidPlan": {
    object (PrepaidPlan)
  }
  // End of list of possible types for union field plan_type.
  "offerDetails": {
    object (OfferDetails)
  },

  // Union field deferred_item_change can be only one of the following:
  "deferredItemReplacement": {
    object (DeferredItemReplacement)
  }
  // End of list of possible types for union field deferred_item_change.
  "signupPromotion": {
    object (SignupPromotion)
  }
}
*/
class SubscriptionLineItem {
  constructor(json) {
    json = json || {};
    /**
     * @type {string} - The product ID of the subscription line item.
     */
    this.productId = json.productId || "";
    /**
     * @type {string} - The expiry time of the subscription line item in RFC3339 format.
     */
    this.expiryTime = json.expiryTime || "";
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

/*
{
  "autoRenewEnabled": boolean,
  "recurringPrice": {
    object (Money)
  },
  "priceChangeDetails": {
    object (SubscriptionItemPriceChangeDetails)
  },
  "installmentDetails": {
    object (InstallmentPlan)
  }
}
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

/*
{
  "newPrice": {
    object (Money)
  },
  "priceChangeMode": enum (PriceChangeMode),
  "priceChangeState": enum (PriceChangeState),
  "expectedNewPriceChargeTime": string
}
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
{
  "currencyCode": string,
  "units": string,
  "nanos": integer
}
@see https://developers.google.com/android-publisher/api-ref/rest/v3/Money
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
    this.nanos = json.nanos || -1;
  }
}

/*
{
  "initialCommittedPaymentsCount": integer,
  "subsequentCommittedPaymentsCount": integer,
  "remainingCommittedPaymentsCount": integer,
  "pendingCancellation": {
    object (PendingCancellation)
  }
}
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

/*
{
  "allowExtendAfterTime": string
}
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

/*
{
  "offerTags": [
    string
  ],
  "basePlanId": string,
  "offerId": string
}
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

/*
{
  "productId": string
}
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

/*
{
  // Union field promotion_type can be only one of the following:
  "oneTimeCode": {
    object (OneTimeCode)
  },
  "vanityCode": {
    object (VanityCode)
  }
  // End of list of possible types for union field promotion_type.
}
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

/*
{
  "promotionCode": string
}
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
 *
 * @param {any} env
 * @param {Request} r
 * @returns {Promise<Response>}
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
    await handleSubscriptionNotification(env, notif.sub);
  }
  if (notif.void) {
    await handleVoidedPurchaseNotification(env, notif.void);
  }
  if (notif.test) {
    await handleTestNotification(notif.test);
  }
  logi(
    `processed: ${notif.version}, ${notif.packageName}, ${notif.eventTimeMillis}`
  );
}

/**
 * TODO: stub
 * @param {any} env
 * @param {OneTimeProductNotification} notif
 */
async function handleOneTimeProductNotification(env, notif) {
  logi(
    `One-time: ${notif.notificationType}, ${notif.purchaseToken}, ${notif.sku}`
  );
}

/**
 * @param {any} env
 * @param {SubscriptionNotification} notif
 */
async function handleSubscriptionNotification(env, notif) {
  // developer.android.com/google/play/billing/lifecycle/subscriptions
  // developer.android.com/google/play/billing/security#verify
  if (notif == null || notif.purchaseToken == null) {
    throw new Error("Invalid subscription notification:" + notif);
  }

  const purchasetoken = notif.purchaseToken;
  const typ = notificationTypeStr(notif);
  const sub = await getSubscription(env, purchasetoken);
  const test = sub.testPurchase != null;

  return als.run(new ExecCtx(test), async () => {
    logi(`Subscription: ${typ} for ${purchasetoken} test? ${test}`);

    const cid = await getOrGenAndPersistCid(env, sub);

    return await processSubscription(env, cid, sub, purchasetoken);
  });
}

/**
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {SubscriptionPurchaseV2} sub - Subscription purchase.
 * @returns
 */
async function processSubscription(env, cid, sub, purchasetoken) {
  const test = sub.testPurchase != null;

  const state = sub.subscriptionState;
  // RECOVERED, RENEWED, PURCHASED, RESTARTED must have "active" states
  const active = state === "SUBSCRIPTION_STATE_ACTIVE";
  // Usually, state is set to EXPIRED on notification type REVOKED & EXPIRED
  // For states CANCELED, ON_HOLD, IN_GRACE_PERIOD, PAUSED, access must not be revoked.
  // use lineItems.expiryTime to determine the exact product to revoke access to.
  const expired = state === "SUBSCRIPTION_STATE_EXPIRED";
  const unpaid = state === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";
  const revoked = notif.notificationType === 12; // SUBSCRIPTION_REVOKED
  // Per docs, only PURCHASED and RENEWED have to be acknowledged.
  const ackd =
    sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

  // developer.android.com/google/play/billing/subscriptions#pending
  if (active) {
    // SUBSCRIPTION_PURCHASED; Acknowledge
    const [expiry, productId, plan] = productInfo(sub);

    // TODO: check if expiry/productId/plan are valid
    // Play Billing deletes a purchaseToken after 60d from expiry
    await registerOrUpdateActiveSubscription(env, cid, purchasetoken, sub);
    // TODO: handle entitlement for multiple product ids
    const ent = await getOrGenWsEntitlement(env, cid, expiry, plan);
    if (ackd) {
      logi(`Subscription already acknowledged: ${cid} test? ${test}`);
      return;
    }
    if (ent.status === "banned") {
      loge(`Subscription ${ent.status} ${cid} test? ${test}`);
      return; // never ack but report success
    }
    if (ent.status === "expired") {
      // TODO: retry?
      throw new Error(`ent expired ${cid} but sub active; test? ${test}`);
    }
    // developer.android.com/google/play/billing/integrate#process
    // developer.android.com/google/play/billing/subscriptions#handle-subscription
    return await ackSubscription(env, productId, purchasetoken, ent);
  } else if (expired || revoked || unpaid) {
    // on revoke / unpaid, delete entitlement
    const now = Date.now();
    // developer.android.com/google/play/billing/subscriptions#cancel-refund-revoke
    for (const item of sub.lineItems) {
      const productId = item.productId;

      // TODO: handle other lineItems
      if (
        productId != monthlyProxyProductId &&
        productId != annualProxyProductId
      ) {
        loge(`skip revoke sub ${cid} test? ${test}; unknown ${productId}`);
        continue;
      }

      const expiry = item.expiryTime ? new Date(item.expiryTime) : new Date(0);
      const autorenew = item.autoRenewingPlan
        ? item.autoRenewingPlan.autoRenewEnabled
        : false;
      logi(`revoke sub ${cid} ${productId} at ${expiry} (renew? ${autorenew})`);
      if (revoked || unpaid) {
        await deleteWsEntitlement(env, cid);
      } else if (!autorenew && expiry.getTime() < now) {
        // TODO: check if WSUser expiry is far into the future (a lot of grace period
        // even though sub has expired), if so, delete it or let the user use it?
        // await deleteWsEntitlement(env, cid);
        // needed? await revokeSubscription(env, cid, productId, purchasetoken);
      } else {
        loge(`skip revoke ${cid} ${productId} ${expiry}; renews ${autorenew}`);
      }
    }
  } else {
    // SUBSCRIPTION_CANCELED, SUBSCRIPTION_ON_HOLD, SUBSCRIPTION_IN_GRACE_PERIOD, SUBSCRIPTION_PAUSED
    // developer.android.com/google/play/billing/subscriptions#cancel-refund-revoke
    logi(`sub notif: ${cid} ${typ} / ${state}, no-op`);
  }
}

/**
 * @param {any} env
 * @param {VoidedPurchaseNotification} notif
 */
async function handleVoidedPurchaseNotification(env, notif) {
  logi(
    `Voided purchase: ${notif.purchaseToken}, ${notif.orderId}, ${notif.productType}, ${notif.refundType}`
  );
  // TODO: revoke if active
}

/**
 * @param {TestNotification} notif
 */
async function handleTestNotification(notif) {
  logi(`Test: ${notif.version}`);
}

/**
 * @param {any} env
 * @param {string} purchaseToken
 * @returns {Promise<SubscriptionPurchaseV2>}
 * @throws {Error} - If the response is not as expected.
 */
async function getSubscription(env, purchaseToken) {
  // GET
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/purchases/subscriptionsv2/tokens/{purchaseToken}'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const url = `${subsv2}${purchaseToken}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(url, { headers });
  const json = await r.json();
  if (json != null && json.kind === "androidpublisher#subscriptionPurchaseV2") {
    return new SubscriptionPurchaseV2(json);
  } else {
    throw new Error(`Unexpected response ${r.status}: ${json}`);
  }
}

/**
 *
 * @param {any} env - Workers environment.
 * @param {string} cid - Client identifier (hex string).
 * @param {string} productId - Product ID of the subscription.
 * @param {string} purchaseToken - Google Play purchase token.
 * @returns {Promise<void>}
 */
async function revokeSubscription(env, cid, productId, purchaseToken) {
  // POST
  //   -H 'Accept: application/json' \
  //   'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<pkg>/purchases/subscriptions/<sku>/tokens/<token>:revoke'
  const revokeurl = `${revoke}${productId}${tokenp}${purchaseToken}${revokesuffix}`;
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  const r = await fetch(revokeurl, { method: "POST", headers });
  if (!r.ok) {
    // TODO: retry for 3 days with pipeline?
    throw new Error(`Failed to revoke sub ${cid} ${productId}: ${r.status}`);
  }
}

/**
 *
 * @param {any} env
 * @param {string} productId - Product ID of the subscription.
 * @param {string} purchaseToken - Google Play purchase token.
 * @param {WSEntitlement} ent - Windscribe entitlement
 * @returns {Promise<void>}
 * @throws {Error} - If the acknowledgment fails.
 */
async function ackSubscription(env, productId, purchaseToken, ent) {
  // POST
  // 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/purchases/tokens/{purchaseToken}:acknowledge'
  // -H 'Accept: application/json' \
  // -H 'Authorization: Bearer <YOUR_ACCESS_TOKEN>'
  const ackurl = `${ack}${productId}${tokenp}${purchaseToken}${acksuffix}`;
  const bearer = await gtoken(env.GCP_REDIR_SVC_CREDS);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  if (ent != null) {
    const body = JSON.stringify({
      developerPayload: {
        ws: ent,
      },
    });
    const r = await fetch(ackurl, {
      method: "POST",
      headers: headers,
      body: body,
    });
    if (!r.ok) {
      // TODO: retry for 3 days with pipeline?
      throw new Error(`Failed to ack sub ${productId}: ${r.status}`);
    }
  } else {
    if (donotAckWithoutEntitlement) {
      throw new Error(`No entitlement for ${productId}, cannot ack sub`);
    }
    // no entitlement, just ack
    const r = await fetch(ackurl, { method: "POST", headers });
    if (!r.ok) {
      // TODO: retry for 3 days with pipeline?
      throw new Error(`Failed to ack sub for ${productId}: ${r.status}`);
    }
  }
}

/**
 * @param {any} env
 * @param {SubscriptionPurchaseV2} sub
 * @returns {Promise<string|null>}
 * @throws {Error} - If the CID cannot be retrieved or generated.
 */
async function getCidThenPersist(env, sub) {
  return getOrGenAndPersistCid(env, sub, false, true);
}

// if gen is true, refuse to acknowledge subs with missing obfuscated external account ID
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
    logi(`Failed to get CID: ${msg}, generating new CID`);
  }
  if (!cid || cid.length < mincidlength) {
    cid = crandHex(64);
    kind = 1; // generated
  }
  if (kind == 1 && gen) {
    throw new Error("cid missing for purchase token: err? " + msg);
  }
  if (insert) {
    const clientinfo = sub.subscribeWithGoogleInfo;
    const out = await dbx.insertClient(db, cid, clientinfo, kind);
    if (out == null || !out.success) {
      throw new Error(`cid: failed to get or insert ${cid}`);
    }
  }
  return cid; // all okay
}

/**
 * @param {any} env
 * @param {string} cid - Client ID, usually the obfuscatedExternalAccountId.
 * @param {string} pt - Purchase token.
 * @param {SubscriptionPurchaseV2} sub
 * @param {Promise<dbx.D1Out>} out - The result of db op.
 */
async function registerOrUpdateActiveSubscription(env, cid, pt, sub) {
  return dbx.upsertPlaySub(dbx.db(env), cid, pt, sub.linkedPurchaseToken, sub);
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
      n + 1
    );
  }
  throw new Error(
    `Cid ${cid} (${cidlen} ${n}) missing or invalid for profile ${sub.subscribeWithGoogleInfo.profileId}, ${sub.regionCode}, ${sub.startTime}`
  );
}

/**
 * @param {SubscriptionPurchaseV2} sub
 * @returns {[expiry: Date, productId: string, plan: "month"|"year"|"unknown"]} - The expiry date and product ID of the subscription.
 * @throws {Error} - If the subscription line items are invalid.
 */
function productInfo(sub) {
  if (!sub || !sub.lineItems || sub.lineItems.length === 0) {
    throw new Error("No sub line items");
  }
  // TODO: support multiple line items
  // TODO: match incoming purchaetoken with orderid?
  const item = sub.lineItems[0];
  // expiryTime is in RFC3339 format
  // "2014-10-02T15:01:23Z", "2014-10-02T15:01:23.045123456Z", or "2014-10-02T15:01:23+05:30".
  return [new Date(item.expiryTime), item.productId, planInfo(item.productId)];
}

/**
 * @param {string} productId
 * @return {"month" | "year" | "unknown"} - The plan type based on the product ID.
 */
function planInfo(productId) {
  if (productId === monthlyProxyProductId) {
    return "month";
  } else if (productId === annualProxyProductId) {
    return "year";
  }
  return "unknown";
}

// ryan-schachte.com/blog/oauth_cloudflare_workers / archive.vn/B3FYC
async function gtoken(creds) {
  const key = JSON.parse(creds);
  const gauth = new GoogleAuth(key, androidscope);
  return await gauth.getGoogleAuthToken();
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
  try {
    // Parse request body to get purchase token
    const url = new URL(req.url);
    const purchasetoken =
      url.searchParams.get("purchaseToken") ||
      url.searchParams.get("purchasetoken");
    const cid = url.searchParams.get("cid");

    if (!purchasetoken) {
      return r400j({ error: "purchaseToken is required" });
    }

    // get subscription details from google play
    const sub = await getSubscription(env, purchasetoken);
    const test = sub.testPurchase != null;
    const state = sub.subscriptionState;
    const ackstate = sub.acknowledgementState;
    const active = state === "SUBSCRIPTION_STATE_ACTIVE";
    const ackd = ackstate === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

    logi(
      `handle ack for ${purchasetoken} at ${state}/${ackstate}; test? ${test}`
    );

    if (ackd) {
      return r200j({ message: "already acknowledged", cid: cid });
    }
    if (!active) {
      loge(`Cannot ack inactive subscription: ${cid}, state: ${state}`);
      return r400j({ error: "subscription not active", state: state });
    }

    const [expiry, productId, plan] = productInfo(sub);

    return await als.run(new ExecCtx(test), async () => {
      // TODO: check if expiry/productId/plan are valid
      // Play Billing deletes a purchaseToken after 60d from expiry
      await registerOrUpdateActiveSubscription(env, cid, purchasetoken, sub);
      if (Date.now() > expiry.getTime()) {
        return r400j({
          error: "subscription expired",
          cid: cid,
          expiry: expiry.toISOString(),
        });
      }

      try {
        // TODO: validate cid only for credential-less accounts
        // credentialed accounts can have different cids
        const existingCid = await getCidThenPersist(env, sub);
        if (existingCid !== cid) {
          loge(`CID (us!=them) ${existingCid} != ${cid} for ${purchasetoken}`);
          return r400j({
            error: `cid ${cid} not regist ered with purchase token`,
          });
        }
      } catch (e) {
        loge(`Err validating CID for purchase (sent: ${cid}): ${e.message}`);
      }

      const ent = await getOrGenWsEntitlement(env, cid, expiry, plan);
      if (!ent) {
        return r500j({ error: "failed to get entitlement", cid: cid });
      }
      if (ent.status === "banned") {
        return r400j({ error: "user banned", cid: cid });
      }
      if (ent.status === "expired") {
        return r400j({ error: "entitlement expired", cid: cid });
      }
      if (ent.status !== "valid") {
        return r400j({
          error: "invalid entitlement status",
          status: ent.status,
          cid: cid,
        });
      }

      await ackSubscription(env, productId, purchasetoken, ent);

      return r200j({
        success: true,
        message: "Subscription acknowledged successfully",
        cid: cid,
        productId: productId,
        expiry: expiry.toISOString(),
      });
    });
  } catch (error) {
    return r500j({ error: "acknowledge failed", details: error.message });
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
      return r400j({ error: "method not allowed" });
    }

    const url = new URL(req.url);
    let cid = url.searchParams.get("cid");
    const test = url.searchParams.get("test");
    if (!cid || cid.length < mincidlength) {
      return r400j({ error: "missing/invalid client id" });
    }

    // Validate CID format (should be hex)
    if (!/^[a-fA-F0-9]+$/.test(cid) && cid.length >= mincidlength) {
      return r400j({ error: "invalid cid" });
    }

    // TODO: only allow credentialless clients to access this endpoint
    logd(`get entitlements for ${cid}; test? ${test}`);

    return await als.run(new ExecCtx(test), async () => {
      const out = await creds(env, cid);

      if (!out) {
        return r400j({ error: "entitlement not found", cid: cid });
      }
      if (out.status === "banned") {
        return r400j({ error: "user banned", cid: cid });
      }

      return r200j({ success: true, entitlement: out, cid: cid });
    });
  } catch (err) {
    return r500j({ error: "get entitlements failed", details: err.message });
  }
}

function r200j(j) {
  const h = { "content-type": "application/json" };
  return new Response(JSON.stringify(j), { status: 200, headers: h }); // ok
}

function r400j(j) {
  const h = { "content-type": "application/json" };
  return new Response(JSON.stringify(j), { status: 400, headers: h }); // bad request
}

function r500j(j) {
  const h = { "content-type": "application/json" };
  return new Response(JSON.stringify(j), { status: 500, headers: h }); // internal server error
}

function r200t(txt) {
  const h = { "content-type": "application/text" };
  return new Response(txt, { status: 200, headers: h }); // ok
}

function logi(...args) {
  console.info("gplay", ministack(), ...args);
}

function loge(...args) {
  console.error("gplay", ministack(), ...args);
}

function logd(...args) {
  console.debug("gplay", ministack(), ...args);
}

function ministack() {
  const stack = new Error().stack;
  if (!stack) return "nostack";

  const lines = stack.split("\n");
  if (!lines || lines.length === 0) return "nocallers";

  const callers = [];

  // Start from index 3 to skip getCallerInfo, log function, and Error constructor
  for (let i = 1; i < Math.min(6, lines.length); i++) {
    const line = lines[i];
    if (!line) continue;

    // Extract function name and line number from stack trace
    // Format varies by environment, but typically: "at functionName (file:line:column)"
    const match =
      line.match(/\s+([^(]+)\s*\(([^:]+):(\d+):\d+\)/) ||
      line.match(/\s+([^@]+)@([^:]+):(\d+):\d+/) ||
      line.match(/\s+(.+):(\d+):\d+/);

    if (match) {
      const funcName = match[1] ? match[1].trim() : "anonymous";
      const lineNum = match[3] || match[2];
      callers.push(`${funcName}:${lineNum}`);
    }
  }

  return callers.length > 0
    ? `${callers.join(">>")}`
    : "nomatch" + lines.length;
}
