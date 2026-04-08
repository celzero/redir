// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2025 RethinkDNS and its authors

import * as bin from "./buf.js";
import * as dbenc from "./dbenc.js";
import * as glog from "./log.js";
import { consumejson, r200jstr, r400err, r429err, r500err } from "./req.js";
import * as dbx from "./sql/dbx.js";
import { apiurl } from "./wsent.js";

const log = new glog.Log("wsperma");

// AAD for wsperma.meta column: "len:tablename.len:columnname"
// "wsperma" = 7 chars, "meta" = 4 chars
const wspermaad = "7:wsperma.4:meta";

const maxpermacreds = 5;

const resourcewgperma = "WgConfigs/permanent";
const resourcewglistkeys = "WgConfigs/list_keys";

/**
 * Represents the WireGuard config returned by the WS permanent config API.
 */
export class WSPermaConfig {
  /**
   * @param {object} json - The "config" field from data.config in the WS API response
   */
  constructor(json) {
    if (typeof json !== "object" || json == null) {
      throw new TypeError("wsperma: null or invalid config json");
    }
    /** @type {string|null} - WG private key (std base64) */
    this.privateKey = json.PrivateKey || null;
    /** @type {string|null} - WG public key (std base64, 44 chars) */
    this.publicKey = json.PublicKey || null;
    /** @type {string|null} - WG preshared key (std base64) */
    this.presharedKey = json.PresharedKey || null;
    /** @type {string|null} - e.g. "0.0.0.0/0, ::/0" */
    this.allowedIPs = json.AllowedIPs || null;
    /** @type {string|null} - e.g. "100.65.34.140/32" */
    this.address = json.Address || null;
    /** @type {string|null} - e.g. "10.255.255.1" */
    this.dns = json.DNS || null;
  }

  jsonable() {
    return {
      PrivateKey: this.privateKey,
      PublicKey: this.publicKey,
      PresharedKey: this.presharedKey,
      AllowedIPs: this.allowedIPs,
      Address: this.address,
      DNS: this.dns,
    };
  }
}

/**
 * Main entry point for wgconfigs/permanent requests.
 *
 * Lookup order:
 *  1. A wsperma row for this did already exists AND the stored pubkey is
 *     present in the remote list_keys → return decrypted meta to client.
 *  2. A wsperma row for this cid exists with did = NULL AND its pubkey is
 *     present in list_keys → re-assign the row to this did and return.
 *  3. Total rows for this cid < maxpermacreds → create a new permanent config
 *     on the remote, store encrypted, and return.
 *  4. Limit reached or no free slot → return 429.
 *
 * @param {any} env - Worker environment
 * @param {string} cid - Client ID (hex string)
 * @param {string} did - Device ID (hex string)
 * @param {string} sessiontoken - Decrypted session auth hash (id:type:epoch:sig1:sig2)
 * @returns {Promise<Response>}
 */
export async function getOrCreatePermaConfig(env, cid, did, sessiontoken) {
  if (
    bin.emptyString(cid) ||
    bin.emptyString(did) ||
    bin.emptyString(sessiontoken)
  ) {
    log.e(`make: empty cid/did/sess ${cid}/${did}`);
    return r400err("wsperma: make: missing cid/did/sessiontoken");
  }

  const db = dbx.db(env);

  // if row found, verify pubkey is still registered remotely
  // step 2: look for a null-did row whose pubkey is in remoteKeys
  const out = await dbx.getPermasByCid(db, cid);
  const allRows = out.results || [];

  const remoteKeys = await listkeys(env, sessiontoken);

  // step 1: check for an existing row belonging to this did
  const onerow = allRows.filter((r) => r.did === did);
  if (onerow.length > 0) {
    // TODO: len(out.results) == 1?
    const existingRow = onerow[0];
    if (remoteKeys.includes(existingRow.pubkey)) {
      // pubkey still alive – decrypt and return to client
      const plain = await decryptMeta(env, cid, existingRow.meta);
      if (plain != null) {
        log.d(`make: returning existing perma for did=${did}`);
        return r200jstr(plain);
      }
      return r500err("make: could not decrypt cred");
    } else {
      log.i(`make: unknown pubkey ${existingRow.pubkey}; reassign or create`);
    }
  }

  // step 2: look for an orphaned row (did=null) if any whose pubkey is in remoteKeys
  const deleteKeys = [];
  for (const row of allRows) {
    if (!remoteKeys.includes(row.pubkey)) {
      deleteKeys.push(row.pubkey);
      continue; // key gone from remote
    }

    // row not orphaned?
    if (row.did != null) continue;

    // reassign this orphaned row to the current did
    const out = await dbx.reassignPermaDid(db, row.pubkey, did);
    if (!out.success) {
      log.e(`make: db err reassign pubkey ${row.pubkey} to did=${did}`);
      continue; // try next one if any
    }

    if (deleteKeys.length > 0) {
      go(deletePermaKeys, deleteKeys); // async
    }

    log.i(`make: reassigned pubkey ${row.pubkey} to did=${did}`);

    const plain = await decryptMeta(env, cid, row.meta);

    // TODO: validate public and private key fields
    if (plain == null) return r500err("wsperma: make: reassigned decrypt err");

    return r200jstr(plain);
  }

  // step 3: check cap before creating a new credential
  // count all rows (including null-did); once created they are permanent
  if (remoteKeys.length >= maxpermacreds) {
    log.w(`wsperma: make: cap for ${cid} at: ${remoteKeys}`);
    return r429err(`wsperma: make: limit reached`);
  }

  log.d(`wsperma: make: creating for did=${did} (n: ${remoteKeys.length})`);

  // step 4: call the remote WS API to create a new permanent config
  const r = await vendPermaConfig(env, sessiontoken);
  if (!r.ok) {
    const errstr = await consumejson(r);
    log.e(`wsperma: make: remote ${r.status}: ${errstr}`);
    // clone r status etc and errstr as json
    return new Response(JSON.stringify({ error: errstr }), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const json = await consumejson(r);
  const noremotejson = json == null;
  // validate PrivateKey is present; without it we cannot manage the credential
  const config = json?.data?.config;
  const noconfig = config == null;
  const nodata = json?.data == null;
  const nopriv = config?.PrivateKey == null;
  if (noremotejson || nodata || noconfig || nopriv) {
    log.e(
      `make: missing res? ${noremotejson} nodata? ${nodata} nocfg? ${noconfig} nopriv? ${nopriv}`,
    );
    return r400err("wsperma: make: generated unmanaged credential");
  }

  const pubkey = config.PublicKey;
  if (bin.emptyString(pubkey)) {
    // TODO: delete?
    return r400err("wsperma: make: generated credential missing pubkey");
  }

  try {
    const jsonstr = JSON.stringify(json);
    // encrypt and store the entire remote json in wsperma.meta
    const encmeta = await encryptMeta(env, cid, jsonstr);
    if (bin.emptyString(encmeta)) {
      // TODO: delete?
      return r500err("wsperma: make: db encryption failure");
    }

    const out = await dbx.upsertPerma(db, pubkey, did, cid, encmeta);
    if (!out.success) {
      // TODO: retry?
      log.e("wsperma: make: upsert failed");
      log.o(out);
      return r500err(`wsperma: make: db failure`);
    }

    log.i(`wsperma: make: new perma ${pubkey} for did=${did}`);
    // return the original remote json to the client
    return r200jstr(jsonstr);
  } catch (e) {
    // TODO: retry
    log.e("wsperma: make: encrypt/upsert error", e);
    return r500err(`wsperma: make: db failure: ${e.message}`);
  }
}

/**
 * Calls WgConfigs/list_keys and returns the array of public key strings.
 * @param {any} env
 * @param {string} sessiontoken
 * @returns {Promise<string[]>}
 * @throws {Error} on network or unexpected errors
 */
async function listkeys(env, sessiontoken) {
  const url = apiurl(env) + resourcewglistkeys;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${sessiontoken}` },
  });
  if (!r.ok) {
    const err = await consumejson(r);
    const errstr = JSON.stringify(err);
    log.e(`fetchListKeys: remote ${r.status}: ${errstr}`);
    throw new Error(`wsperma: not servicable ${r.status}: ${errstr}`);
  }
  const j = await consumejson(r);
  const keys = j?.data?.pub_keys;
  if (!Array.isArray(keys)) {
    log.e(`listkeys: unexpected response shape ${JSON.stringify(j)}`);
    throw new Error("wsperma: listkeys: unexpected response");
  }
  return keys;
}

/**
 * Calls WgConfigs/permanent (POST, port=443) to create a new managed
 * permanent WireGuard credential. Returns the JSON response from the
 * remote API on success, or throws an error on failure.
 * @param {any} env
 * @param {string} sessiontoken
 * @returns {Promise<Response>} json response
 */
async function vendPermaConfig(env, sessiontoken) {
  const url = apiurl(env) + resourcewgperma;
  const body = new URLSearchParams({ port: "443" }); // some valid port
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessiontoken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
}

/**
 * Deletes any wsperma rows whose pubkeys are not present in the remote list_keys.
 * @param {Array<string>} pubkeys
 * @returns {Promise<dbx.D1Out?>}
 */
async function deletePermaKeys(pubkeys) {
  try {
    // delete any rows whose keys are gone from remote
    const delout = await dbx.deletePermasByPubkeys(db, deleteKeys);
    if (!delout.success) {
      log.e(`make: db err deleting orphaned pubkeys ${deleteKeys}`);
    } else {
      log.d(`make: deleted orphaned pubkeys ${deleteKeys}`);
    }
    return delout;
  } catch (ignore) {
    log.e(`make: db err deleting orphaned pubkeys ${deleteKeys}`, ignore);
  }
  return null;
}

/**
 * Encrypts a JSON string for storage in wsperma.meta using dbenc.encrypt2
 * (random IV, prepended to ciphertext).
 *
 * @param {any} env
 * @param {string} cid - Client ID (hex) used as encryption key anchor
 * @param {string} plaintext - raw JSON string to encrypt
 * @returns {Promise<string|null>} - ivtaggedciphertext hex or null
 */
async function encryptMeta(env, cid, plaintext) {
  return dbenc.encryptText2(env, cid, wspermaad, plaintext);
}

/**
 * Decrypts the meta column of a wsperma row.
 * Returns the original JSON string or null on failure.
 *
 * @param {any} env
 * @param {string} cid - Client ID (hex)
 * @param {string} encmeta - ivtaggedciphertext hex from wsperma.meta
 * @returns {Promise<string|null>}
 */
async function decryptMeta(env, cid, encmeta) {
  return dbenc.decryptText2(env, cid, wspermaad, encmeta);
}
