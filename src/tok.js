/*
 * Copyright (c) 2023 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

export const twentyFiveHoursMs = 25 * 60 * 60 * 1000;
export const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
const maxTokens = ((thirtyDaysMs / twentyFiveHoursMs) * 2) | 0; // 57

export class TokenStatus {
  constructor(errmsg = null) {
    /** @type {number} */
    this.n = 0; // total tokens issued
    /** @type {number} */
    this.ts = 0; // the timestamp of the very first token
    /** @type {number} */
    this.factor = 1; // total authorized tokens = factor * maxTokens
    /** @type {string} */
    this.errmsg = errmsg;
  }

  /**
   * @param {string|number} isostring
   */
  set at(isostring) {
    // isostring is of form "2023-07-14 11:09:54" or a unix timestamp
    this.ts = new Date(isostring).getTime();
  }

  get noerr() {
    return this.errmsg == null || this.errmsg == "";
  }

  get err() {
    if (!this.noerr) return this.errmsg;
    if (!this.tsok) return "expired";
    if (!this.countok) return "too many tokens";
    return "";
  }

  get countok() {
    return this.n >= 0 && this.n < maxTokens * this.factor;
  }

  get tsok() {
    return (this.ts + thirtyDaysMs * this.factor) > Date.now();
  }

  get ok() {
    return this.err == null || this.err == "";
  }
}

/**
 * @param {number} c
 * @param {string|number} freeformTimeStr
 * @param {number} f
 * @returns {TokenStatus}
 */
export function tokenStatusOf(c, f, freeformTimeStr) {
  const st = new TokenStatus();
  st.at = freeformTimeStr;
  st.factor = f || 1;
  st.n = c;
  return st;
}

export function errTokenStatus(msg = "error") {
  return new TokenStatus(msg);
}
