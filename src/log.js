/*
 * Copyright (c) 2025 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * loglevel - global log level
 * 0 = debug, 1 = info, 2 = warn, 3 = error
 * @type {number}
 */
export let loglevel = 1;

export class Log {
  constructor(tag, level = 0, trace = true) {
    /**
     * @type {string}
     */
    this.tag = tag || "";
    /**
     * @type {number} - Log level, 0 = debug, 1 = info, 2 = warn, 3 = error
     */
    this.level = level;
    /**
     * @type {boolean}
     */
    this.trace = trace;
  }

  i(...args) {
    if (this instanceof Log === false) {
      console.warn("NOINSTANCE", ...args);
    }
    if (this.level > 1) return;
    if (this.trace) {
      args.unshift(ministack());
    }
    console.info(this.tag, ...args);
  }
  w(...args) {
    if (this instanceof Log === false) {
      console.warn("NOINSTANCE", ...args);
    }
    if (this.level > 2) return;
    if (this.trace) {
      args.unshift(ministack());
    }
    console.warn(this.tag, ...args);
  }
  e(...args) {
    if (this instanceof Log === false) {
      console.warn("NOINSTANCE", ...args);
    }
    if (this.level > 3) return;
    if (this.trace) {
      args.unshift(ministack());
    }
    console.error(this.tag, ...args);
  }
  d(...args) {
    if (this instanceof Log === false) {
      console.warn("NOINSTANCE", ...args);
    }
    if (this.level > 0) return;
    if (this.trace) {
      args.unshift(ministack());
    }
    console.debug(this.tag, ...args);
  }
  o(obj) {
    if (this instanceof Log === false) {
      console.warn("NOINSTANCE object:");
      console.dir(obj);
    }
    this.i("object:");
    console.dir(obj);
  }
}

export function i(...args) {
  if (loglevel > 1) return;
  console.info(ministack(), ...args);
}

export function w(...args) {
  if (loglevel > 2) return;
  console.warn(ministack(), ...args);
}

export function e(...args) {
  if (loglevel > 3) return;
  console.error(ministack(), ...args);
}

export function d(...args) {
  if (loglevel > 0) return;
  console.debug(ministack(), ...args);
}

export function o(obj) {
  console.dir(obj);
}

function ministack() {
  const stack = new Error().stack;
  if (!stack) return "nostack";

  const lines = stack.split("\n");
  if (!lines || lines.length === 0) return "nocallers";

  const cc = [];

  // Start from index 3 to skip ministack, log function, and Error constructor
  for (let i = 3; i < Math.min(6, lines.length); i++) {
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
      cc.push(`${funcName}:${lineNum}`);
    }
  }

  return cc.length > 0 ? `${cc.join(" ")}` : "nomatch" + lines.length;
}
