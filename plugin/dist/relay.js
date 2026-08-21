#!/usr/bin/env bun
// @bun

// src/relay/keepalive.ts
var KEEPALIVE_KEY = "__keepalive__";
async function keepalive(request, store) {
  if (request.method !== "GET") {
    return json({ ok: false, detail: `\uBC1B\uC9C0 \uC54A\uB294 \uBA54\uC11C\uB4DC\uB2E4: ${request.method}` }, 405, {
      allow: "GET"
    });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return json({ ok: false, detail: "CRON_SECRET \uC774 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uB2E4" }, 500);
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ ok: false, detail: "unauthorized" }, 401);
  }
  try {
    const depth = await store.depth(KEEPALIVE_KEY);
    return json({ ok: true, depth });
  } catch (e) {
    return json({ ok: false, detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

// src/crypto/envelope.ts
var MAGIC = 1095583793;
var CHANNEL_TAG_BYTES = 16;
var MESSAGE_ID_BYTES = 16;
var KEY_ID_BYTES = 8;
var NONCE_BYTES = 24;
var SIGNATURE_BYTES = 64;
var WRAPPED_KEY_BYTES = 80;
var HEADER_FIXED_BYTES = 4 + CHANNEL_TAG_BYTES + MESSAGE_ID_BYTES + KEY_ID_BYTES + 8 + 8 + NONCE_BYTES;
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_RECIPIENTS = 256;
function hasFinalConsonant(word) {
  const last = word.codePointAt(word.length - 1);
  const isHangulSyllable = last !== undefined && last >= 44032 && last <= 55203;
  return !isHangulSyllable || (last - 44032) % 28 !== 0;
}
function withObjectParticle(word) {
  return `${word}${hasFinalConsonant(word) ? "\uC744" : "\uB97C"}`;
}
function truncated(what) {
  return new Error(`\uBD09\uD22C\uAC00 \uC798\uB838\uB2E4 \u2014 ${withObjectParticle(what)} \uC77D\uC744 \uC218 \uC5C6\uB2E4`);
}
function decode(buf) {
  const need = (n, what) => {
    if (buf.length < n)
      throw truncated(what);
  };
  need(HEADER_FIXED_BYTES + 4 + SIGNATURE_BYTES, "\uD5E4\uB354");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, false) !== MAGIC)
    throw new Error("\uBD09\uD22C \uD615\uC2DD\uC774 \uC544\uB2C8\uB2E4");
  let off = 4;
  const take = (n) => {
    const s = buf.subarray(off, off + n);
    off += n;
    return s;
  };
  const channelTag = take(CHANNEL_TAG_BYTES);
  const messageId = take(MESSAGE_ID_BYTES);
  const senderKeyId = take(KEY_ID_BYTES);
  const seq = view.getBigUint64(off, false);
  off += 8;
  const timestamp = view.getBigUint64(off, false);
  off += 8;
  const nonce = take(NONCE_BYTES);
  const count = view.getUint32(off, false);
  off += 4;
  if (count > MAX_RECIPIENTS)
    throw new Error(`\uC218\uC2E0\uC790\uAC00 \uB108\uBB34 \uB9CE\uB2E4 (${count})`);
  need(off + count * (KEY_ID_BYTES + WRAPPED_KEY_BYTES) + SIGNATURE_BYTES, "\uB798\uD551 \uD0A4");
  const keys = [];
  for (let i = 0;i < count; i++) {
    keys.push({ keyId: take(KEY_ID_BYTES), wrapped: take(WRAPPED_KEY_BYTES) });
  }
  const bodyLen = buf.length - off - SIGNATURE_BYTES;
  if (bodyLen < 0)
    throw truncated("\uBCF8\uBB38");
  if (bodyLen > MAX_BODY_BYTES)
    throw new Error(`\uBCF8\uBB38\uC774 \uB108\uBB34 \uD06C\uB2E4 (${bodyLen}B)`);
  const body = take(bodyLen);
  const signature = take(SIGNATURE_BYTES);
  return {
    header: { channelTag, messageId, senderKeyId, seq, timestamp, nonce },
    keys,
    body,
    signature
  };
}

// src/relay/relay.ts
var MAX_ENVELOPE_BYTES = MAX_BODY_BYTES + 64 * 1024;
var DEFAULT_DRAIN_LIMIT = 100;

class Relay {
  store;
  maxBytes;
  drainLimit;
  now;
  constructor(options) {
    this.store = options.store;
    this.maxBytes = options.maxEnvelopeBytes ?? MAX_ENVELOPE_BYTES;
    this.drainLimit = options.drainLimit ?? DEFAULT_DRAIN_LIMIT;
    this.now = options.now ?? Date.now;
  }
  async post(wire) {
    if (wire.length > this.maxBytes) {
      return no("too-large", `\uBD09\uD22C\uAC00 \uB108\uBB34 \uD06C\uB2E4 (${wire.length}B > ${this.maxBytes}B)`);
    }
    let header, keys;
    try {
      const envelope = decode(wire);
      header = envelope.header;
      keys = envelope.keys;
    } catch (e) {
      return no("malformed", e instanceof Error ? e.message : String(e));
    }
    if (keys.length === 0)
      return no("no-recipients", "\uC218\uC2E0\uC790\uAC00 \uC5C6\uB294 \uBD09\uD22C\uB2E4");
    if (keys.length > MAX_RECIPIENTS) {
      return no("malformed", `\uC218\uC2E0\uC790\uAC00 \uB108\uBB34 \uB9CE\uB2E4 (${keys.length})`);
    }
    const item = { envelope: wire, receivedAt: this.now() };
    await Promise.all(keys.map((k) => this.store.push(hex(k.keyId), item)));
    return { ok: true, recipients: keys.length, messageId: hex(header.messageId) };
  }
  async fetch(recipientKeyId, limit) {
    const n = Math.min(limit ?? this.drainLimit, this.drainLimit);
    return this.store.drain(normalize(recipientKeyId), n);
  }
  async depth(recipientKeyId) {
    return this.store.depth(normalize(recipientKeyId));
  }
}
var no = (reason, detail) => ({ ok: false, reason, detail });
function normalize(keyId) {
  return keyId.toLowerCase();
}
function hex(bytes) {
  let s = "";
  for (const b of bytes)
    s += b.toString(16).padStart(2, "0");
  return s;
}

// node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0;i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === undefined || value.length === length))
    return value;
  if (length !== undefined)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== undefined ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, undefined, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex2 = "";
  for (let i = 0;i < bytes.length; i++) {
    hex2 += hexes[bytes[i]];
  }
  return hex2;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : undefined;
}
function hexToBytes(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex2);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex2.charCodeAt(hi));
    const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex2[hi] + hex2[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aobject(defaults, "defaults");
  if (opts !== undefined)
    aobject(opts, title);
  const merged = Object.assign(defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}

class HashMD {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);

class SHA2_32B extends HashMD {
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16;i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0;i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
}

class _SHA256 extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
}
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);

class SHA2_64B extends HashMD {
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16;i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0;i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}

class _SHA512 extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
}
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256, /* @__PURE__ */ oidNist(1));
var sha512 = /* @__PURE__ */ createHasher(() => new _SHA512, /* @__PURE__ */ oidNist(3));

// node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function aarray(item, title, inner = () => {}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0;i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var concatBytes2 = (...arrays) => concatBytes(...arrays);
var hexToBytes2 = (hex2) => hexToBytes(hex2);
var isBytes2 = isBytes;
var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  return hex2 === "" ? _0n : BigInt("0x" + hex2);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex2 = n.toString(16);
  if (hex2.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex2.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== undefined : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}

// node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2;i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2;w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no2 = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no2)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== undefined && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== undefined && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== undefined ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = new WeakMap;

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = undefined;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}

// node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes3, length) {
  if (randomBytes3 === undefined)
    return;
  afunction(randomBytes3, "randomBytes");
  try {
    const probe = randomBytes3(length);
    if (!isBytes2(probe) || probe.length !== length)
      return;
  } catch {
    return;
  }
  return randomBytes3;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === undefined ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = new WeakMap;
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1;j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0;w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1;bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0;i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}

class ScalarMultiplier {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = new WeakMap;
  baseCanBeBlinded;
  bits;
  constructor(Point, randomBytes3) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes3, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0;w < windows; w++) {
      let acc = base;
      for (let i = 0;i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0;w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1;i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === undefined)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1;i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window = windows - 1;window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0;d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window * W) & mask);
      let sel = table[0];
      for (let i = 1;i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === undefined)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === undefined)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
}
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : undefined);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// node_modules/@noble/curves/abstract/edwards.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n4 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _4n3 = /* @__PURE__ */ BigInt(4);
var _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp, CURVE, x, y) {
  const x2 = Fp.sqr(x);
  const y2 = Fp.sqr(y);
  const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
  const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  if (FpLegendre(Fp, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  const randomBytes3 = opts.randomBytes === undefined ? randomBytes2 : opts.randomBytes;
  const MASK = _2n2 << BigInt(Fp.BYTES * 8) - _1n4;
  function isOdd(n) {
    if (!Fp.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp.isOdd(n);
  }
  const uvRatio = opts.uvRatio === undefined ? (u, v) => {
    try {
      return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const mulA = Fp.eql(CURVE.a, Fp.neg(Fp.ONE)) ? (x) => Fp.neg(x) : Fp.eql(CURVE.a, Fp.ONE) ? (x) => x : (x) => Fp.mul(CURVE.a, x);
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE, Fp.mul(CURVE.Gx, CURVE.Gy));
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    T;
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, Fp.ONE, Fp.mul(x, y));
    }
    static fromBytes(bytes, zip215 = false) {
      const len = Fp.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point"));
      abool(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = Fp.sqr(y);
      const u = Fp.sub(y2, Fp.ONE);
      const v = Fp.sub(Fp.mulN(d, y2), a);
      let { isValid, value: x } = uvRatio(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = isOdd(x);
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = Fp.neg(x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(hex2, zip215 = false) {
      return Point.fromBytes(hexToBytes2(hex2), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = Fp.sqr(X);
      const Y2 = Fp.sqr(Y);
      const Z2 = Fp.sqr(Z);
      const Z4 = Fp.sqr(Z2);
      const aX2 = Fp.mul(X2, a);
      const left = Fp.mul(Fp.add(aX2, Y2), Z2);
      const right = Fp.add(Z4, Fp.mul(d, Fp.mul(X2, Y2)));
      if (!Fp.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      const XY = Fp.mul(X, Y);
      const ZT = Fp.mul(Z, T);
      if (!Fp.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = Fp.mul(X1, Z2);
      const X2Z1 = Fp.mul(X2, Z1);
      const Y1Z2 = Fp.mul(Y1, Z2);
      const Y2Z1 = Fp.mul(Y2, Z1);
      return Fp.eql(X1Z2, X2Z1) && Fp.eql(Y1Z2, Y2Z1);
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(Fp.neg(this.X), this.Y, this.Z, Fp.neg(this.T));
    }
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = Fp.sqr(X1);
      const B = Fp.sqr(Y1);
      const C = Fp.mul(Fp.sqr(Z1), _2n2);
      const D = mulA(A);
      const x1y1 = Fp.addN(X1, Y1);
      const E = Fp.sub(Fp.subN(Fp.sqr(x1y1), A), B);
      const G = Fp.addN(D, B);
      const F = Fp.subN(G, C);
      const H = Fp.subN(D, B);
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    add(other) {
      aedpoint(other);
      const { d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = Fp.mul(X1, X2);
      const B = Fp.mul(Y1, Y2);
      const C = Fp.mul(Fp.mulN(T1, d), T2);
      const D = Fp.mul(Z1, Z2);
      const E = Fp.sub(Fp.subN(Fp.mulN(Fp.addN(X1, Y1), Fp.addN(X2, Y2)), A), B);
      const F = Fp.subN(D, C);
      const G = Fp.addN(D, C);
      const H = Fp.sub(B, mulA(A));
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize2);
      return normalize2([p, f])[0];
    }
    multiplyUnsafe(scalar) {
      if (!Fn.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.mulUnsafe(this, scalar, normalize2);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      return wnaf.mulUnsafe(this, CURVE.n).is0();
    }
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && typeof iz !== "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.create(_8n2) : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ONE };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (cofactor === _2n2)
        return this.double();
      if (cofactor === _4n3)
        return this.double().double();
      if (cofactor === _8n2)
        return this.double().double().double();
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp.toBytes(y);
      bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize2 = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes3);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}
function eddsa(Point, cHash, eddsaOpts = {}) {
  validatePointCons(Point);
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  const hash = cHash;
  const opts = eddsaOpts;
  validateObject(opts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    zip215: "boolean",
    mapToCurve: "function",
    toMontgomery: "function",
    toMontgomerySecret: "function"
  });
  const { prehash } = opts;
  const { BASE, Fp, Fn } = Point;
  const outputLen = hash.outputLen;
  const expectedLen = 2 * Fp.BYTES;
  if (outputLen !== undefined) {
    asafenumber(outputLen, "hash.outputLen");
    if (outputLen !== expectedLen)
      throw new Error(`hash.outputLen must be ${expectedLen}, got ${outputLen}`);
  }
  const randomBytes3 = opts.randomBytes === undefined ? randomBytes2 : opts.randomBytes;
  const toMontgomery = opts.toMontgomery;
  const toMontgomerySecret = opts.toMontgomerySecret;
  const adjustScalarBytes = opts.adjustScalarBytes === undefined ? (bytes) => bytes : opts.adjustScalarBytes;
  const domain = opts.domain === undefined ? (data, ctx, phflag) => {
    abool(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  } : opts.domain;
  function modN_LE(hash2) {
    return Fn.create(bytesToNumberLE(hash2));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    abytes2(key, lengths.secretKey, "secretKey");
    const hashed = abytes2(hash(key), 2 * len, "hashedSecretKey");
    const head = adjustScalarBytes(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(secretKey) {
    return getExtendedPublicKey(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes2(...msgs);
    return modN_LE(hash(domain(msg, abytes2(context, undefined, "context"), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    validateObject(options, {}, {}, "options");
    msg = abytes2(msg, undefined, "message");
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn.create(r + k * scalar);
    if (!Fn.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes2(R, Fn.toBytes(s));
    return abytes2(rs, lengths.signature, "result");
  }
  const verifyOpts = {
    zip215: opts.zip215
  };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    validateObject(options);
    const { context } = options;
    const zip215 = options.zip215 === undefined ? !!verifyOpts.zip215 : options.zip215;
    const len = lengths.signature;
    sig = abytes2(sig, len, "signature");
    msg = abytes2(msg, undefined, "message");
    publicKey = abytes2(publicKey, lengths.publicKey, "publicKey");
    if (zip215 !== undefined)
      abool(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point.fromBytes(publicKey, zip215);
      R = Point.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, r, publicKey, msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed) {
    seed = seed === undefined ? randomBytes3(lengths.seed) : seed;
    return abytes2(seed, lengths.seed, "seed");
  }
  function isValidSecretKey(key) {
    return isBytes2(key) && key.length === lengths.secretKey;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point.fromBytes(key, zip215 === undefined ? verifyOpts.zip215 : zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    toMontgomery(publicKey) {
      if (toMontgomery === undefined)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomery(Point.fromBytes(publicKey));
    },
    toMontgomerySecret(secretKey) {
      if (toMontgomerySecret === undefined)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomerySecret(secretKey);
    }
  };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey),
    getPublicKey,
    sign,
    verify,
    utils,
    Point,
    lengths
  });
}

// node_modules/@noble/curves/ed25519.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _1n5 = /* @__PURE__ */ BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
var _5n2 = /* @__PURE__ */ BigInt(5);
var _8n3 = /* @__PURE__ */ BigInt(8);
var ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n3, P) * b2 % P;
  const b5 = pow2(b4, _1n5, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow3 = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow3, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
var Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
function toMontgomery(point) {
  const { y } = point;
  return Fp.toBytes(Fp.div(_1n5 + y, _1n5 - y));
}
function toMontgomerySecret(secretKey) {
  const size = ed25519_Point.Fp.BYTES;
  abytes(secretKey, size);
  return adjustScalarBytes(sha512(secretKey.subarray(0, size))).subarray(0, size);
}
function ed(opts) {
  return eddsa(ed25519_Point, sha512, Object.assign({ adjustScalarBytes, toMontgomery, toMontgomerySecret, zip215: true }, opts));
}
var ed25519 = /* @__PURE__ */ ed({});

// src/identity/verify.ts
var KEY_ID_BYTES2 = 8;
var INFO_KEY_ID = new TextEncoder().encode("agent-channel-mesh/v1/keyid");
function keyIdOf(kemPublicKey, signPublicKey) {
  const input = new Uint8Array(INFO_KEY_ID.length + kemPublicKey.length + signPublicKey.length);
  input.set(INFO_KEY_ID, 0);
  input.set(kemPublicKey, INFO_KEY_ID.length);
  input.set(signPublicKey, INFO_KEY_ID.length + kemPublicKey.length);
  return sha256(input).slice(0, KEY_ID_BYTES2);
}
function verify(signPublicKey, message, signature) {
  try {
    return ed25519.verify(signature, message, signPublicKey);
  } catch {
    return false;
  }
}

// src/relay/fetch-auth.ts
var FETCH_LABEL = new TextEncoder().encode("acm/v1/fetch");
var FETCH_WINDOW_MS = 5 * 60000;
var FETCH_NONCE_BYTES = 16;
var HEADER_KEM = "X-ACM-Kem";
var HEADER_SIGN = "X-ACM-Sign";
var HEADER_SIG = "X-ACM-Sig";
var HEADER_TIME = "X-ACM-Time";
var HEADER_NONCE = "X-ACM-Nonce";
var PUBLIC_KEY_BYTES = 32;
var SIGNATURE_BYTES2 = 64;
function fetchSigningBytes(keyId, timeMs, nonce) {
  if (keyId.length !== KEY_ID_BYTES2) {
    throw new Error(`key id \uAE38\uC774\uB294 ${KEY_ID_BYTES2}\uBC14\uC774\uD2B8\uC5EC\uC57C \uD55C\uB2E4 (\uBC1B\uC740 \uAC12: ${keyId.length})`);
  }
  if (nonce.length !== FETCH_NONCE_BYTES) {
    throw new Error(`nonce \uAE38\uC774\uB294 ${FETCH_NONCE_BYTES}\uBC14\uC774\uD2B8\uC5EC\uC57C \uD55C\uB2E4 (\uBC1B\uC740 \uAC12: ${nonce.length})`);
  }
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new Error(`timeMs \uAC12\uC740 \uC74C\uC218\uAC00 \uC544\uB2CC \uC548\uC804\uD55C \uC815\uC218\uC5EC\uC57C \uD55C\uB2E4 (\uBC1B\uC740 \uAC12: ${timeMs})`);
  }
  const out = new Uint8Array(FETCH_LABEL.length + keyId.length + 8 + nonce.length);
  let at = 0;
  out.set(FETCH_LABEL, at);
  at += FETCH_LABEL.length;
  out.set(keyId, at);
  at += keyId.length;
  new DataView(out.buffer, out.byteOffset + at, 8).setBigUint64(0, BigInt(timeMs));
  at += 8;
  out.set(nonce, at);
  return out;
}
function parseFetchAuth(headers) {
  const kemPublicKey = fromHex(headers.get(HEADER_KEM), PUBLIC_KEY_BYTES);
  const signPublicKey = fromHex(headers.get(HEADER_SIGN), PUBLIC_KEY_BYTES);
  const signature = fromHex(headers.get(HEADER_SIG), SIGNATURE_BYTES2);
  const nonce = fromHex(headers.get(HEADER_NONCE), FETCH_NONCE_BYTES);
  if (!kemPublicKey || !signPublicKey || !signature || !nonce)
    return null;
  const rawTime = headers.get(HEADER_TIME);
  if (rawTime === null || !/^[0-9]+$/.test(rawTime))
    return null;
  const timeMs = Number(rawTime);
  if (!Number.isSafeInteger(timeMs))
    return null;
  return { kemPublicKey, signPublicKey, signature, timeMs, nonce };
}
function verifyFetchAuth(keyIdHex, auth, nowMs) {
  const skew = Math.abs(nowMs - auth.timeMs);
  if (skew > FETCH_WINDOW_MS) {
    return {
      ok: false,
      reason: "stale-request",
      detail: `\uC694\uCCAD \uC2DC\uAC01\uC774 \uCC3D(${FETCH_WINDOW_MS}ms) \uBC16\uC774\uB2E4 (\uCC28\uC774: ${skew}ms)`
    };
  }
  const keyId = keyIdOf(auth.kemPublicKey, auth.signPublicKey);
  const derived = hex2(keyId);
  if (derived !== keyIdHex.toLowerCase()) {
    return {
      ok: false,
      reason: "key-id-mismatch",
      detail: `\uC81C\uC2DC\uB41C \uACF5\uAC1C\uD0A4\uAC00 \uD30C\uC0DD\uD558\uB294 key id \uB2E4: ${derived}`
    };
  }
  const message = fetchSigningBytes(keyId, auth.timeMs, auth.nonce);
  if (!verify(auth.signPublicKey, message, auth.signature)) {
    return { ok: false, reason: "bad-signature", detail: "\uC11C\uBA85\uC774 \uC11C\uBA85 \uB300\uC0C1\uACFC \uB9DE\uC9C0 \uC54A\uB294\uB2E4" };
  }
  return { ok: true };
}
function hex2(bytes) {
  let s = "";
  for (const b of bytes)
    s += b.toString(16).padStart(2, "0");
  return s;
}
function fromHex(text, bytes) {
  if (text === null || text.length !== bytes * 2)
    return null;
  if (!/^[0-9a-f]+$/i.test(text))
    return null;
  const out = new Uint8Array(bytes);
  for (let i = 0;i < bytes; i++)
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// src/relay/post-auth.ts
var HEADER_POST_AUTH = "Authorization";
var MIN_TOKEN_CHARS = 32;
function parseBearer(headers) {
  const raw = headers.get(HEADER_POST_AUTH);
  if (raw === null)
    return;
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  return m?.[1];
}
function verifyPostAuth(auth, headers) {
  if ("open" in auth)
    return { ok: true };
  const given = parseBearer(headers);
  if (given === undefined) {
    return {
      ok: false,
      reason: "missing-auth",
      detail: `\uBD09\uD22C\uB97C \uC62C\uB9AC\uB824\uBA74 ${HEADER_POST_AUTH}: Bearer <\uD1A0\uD070> \uC774 \uD544\uC694\uD558\uB2E4 (\xA710.13)`
    };
  }
  if (!constantTimeEqual(given, auth.token)) {
    return { ok: false, reason: "bad-token", detail: "\uD1A0\uD070\uC774 \uB9DE\uC9C0 \uC54A\uB294\uB2E4" };
  }
  return { ok: true };
}
function constantTimeEqual(a, b) {
  const ha = sha256(new TextEncoder().encode(a));
  const hb = sha256(new TextEncoder().encode(b));
  let diff = 0;
  for (let i = 0;i < ha.length; i++)
    diff |= ha[i] ^ hb[i];
  return diff === 0;
}
function selectPostAuth(env, context) {
  const token = env.ACM_RELAY_TOKEN?.trim();
  if (token !== undefined && token !== "") {
    if (token.length < MIN_TOKEN_CHARS) {
      throw new Error(`ACM_RELAY_TOKEN \uC774 \uB108\uBB34 \uC9E7\uB2E4 (${String(token.length)}\uC790, \uCD5C\uC18C ${String(MIN_TOKEN_CHARS)}\uC790). ` + "\uC9E7\uC740 \uD1A0\uD070\uC740 \uC778\uC99D\uC774 \uC788\uB2E4\uB294 \uCC29\uAC01\uB9CC \uC900\uB2E4 \u2014 `openssl rand -hex 32` \uB85C \uB9CC\uB4E0\uB2E4.");
    }
    return { token };
  }
  if (context.serverless || !isLoopback(context.host)) {
    throw new Error("\uC4F0\uAE30 \uC778\uC99D \uC5C6\uC774 \uACF5\uAC1C \uC8FC\uC18C\uC5D0 \uB728\uC9C0 \uC54A\uB294\uB2E4 \u2014 \uB204\uAD6C\uB098 \uB0A8\uC758 \uC218\uC2E0\uD568\uC5D0 \uBD09\uD22C\uB97C \uBC00\uC5B4 \uB123\uC5B4 " + "\uC544\uC9C1 \uBABB \uBC1B\uC740 \uBA54\uC2DC\uC9C0\uB97C \uD050 \uBC16\uC73C\uB85C \uBC00\uC5B4\uB0BC \uC218 \uC788\uACE0, \uB2F9\uD55C \uCABD\uC5D0\uC11C\uB294 \uADF8 \uC720\uC2E4\uC774 \uBCF4\uC774\uC9C0 \uC54A\uB294\uB2E4. " + "ACM_RELAY_TOKEN \uC744 \uC124\uC815\uD55C\uB2E4 (`openssl rand -hex 32`). " + "\uC778\uC99D \uC5C6\uC774 \uB744\uC6B0\uB824\uBA74 \uB8E8\uD504\uBC31(--host 127.0.0.1)\uC73C\uB85C\uB9CC \uB744\uC6B4\uB2E4.");
  }
  return { open: true };
}
function isLoopback(host) {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// src/relay/http.ts
var AUTH_HEADERS = [HEADER_KEM, HEADER_SIGN, HEADER_SIG, HEADER_TIME, HEADER_NONCE].join(", ");
var KEY_ID_PATTERN = /^[0-9a-f]{16}$/i;
function createHandler(options) {
  const relay = new Relay(options);
  const fetchLimit = options.fetchLimit;
  const postAuth = options.postAuth;
  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && path === "/health") {
      return json2({ ok: true });
    }
    if (req.method === "POST" && path === "/post") {
      const allowed = verifyPostAuth(postAuth, req.headers);
      if (!allowed.ok) {
        return json2({ ok: false, reason: allowed.reason, detail: allowed.detail }, 401);
      }
      const body = new Uint8Array(await req.arrayBuffer());
      const result = await relay.post(body);
      if (!result.ok) {
        const status = result.reason === "too-large" ? 413 : 400;
        return json2({ ok: false, reason: result.reason, detail: result.detail }, status);
      }
      return json2({
        ok: true,
        recipients: result.recipients,
        messageId: result.messageId
      });
    }
    const fetching = path.match(/^\/fetch\/([^/]+)$/);
    if (req.method === "GET" && fetching) {
      const keyId = fetching[1];
      if (!KEY_ID_PATTERN.test(keyId)) {
        return json2({ ok: false, reason: "bad-key-id", detail: "key id \uB294 hex 16\uC790\uC5EC\uC57C \uD55C\uB2E4" }, 400);
      }
      const auth = parseFetchAuth(req.headers);
      if (!auth) {
        return json2({
          ok: false,
          reason: "missing-auth",
          detail: `\uC870\uD68C\uC5D0\uB294 \uC778\uC99D \uD5E4\uB354\uAC00 \uD544\uC694\uD558\uB2E4: ${AUTH_HEADERS} (\xA710.12)`
        }, 401);
      }
      const verified = verifyFetchAuth(keyId, auth, Date.now());
      if (!verified.ok) {
        return json2({ ok: false, reason: verified.reason, detail: verified.detail }, 401);
      }
      const items = await relay.fetch(keyId, fetchLimit);
      return json2({
        ok: true,
        messages: items.map((i) => ({
          envelope: base64(i.envelope),
          receivedAt: i.receivedAt
        }))
      });
    }
    return json2({ ok: false, reason: "not-found", detail: `${req.method} ${path}` }, 404);
  };
}
function json2(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function base64(bytes) {
  let s = "";
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s);
}

// src/relay/store.ts
var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var DEFAULT_MAX_QUEUE = 1000;

class MemoryStore {
  queues = new Map;
  ttlMs;
  maxQueue;
  now;
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.now = options.now ?? Date.now;
  }
  async push(recipient, item) {
    const queue = this.live(recipient);
    if (queue.length >= this.maxQueue) {
      queue.shift();
    }
    queue.push(item);
    this.queues.set(recipient, queue);
  }
  async drain(recipient, limit) {
    const queue = this.live(recipient);
    const taken = queue.splice(0, Math.max(0, limit));
    if (queue.length === 0)
      this.queues.delete(recipient);
    else
      this.queues.set(recipient, queue);
    return taken;
  }
  async depth(recipient) {
    return this.live(recipient).length;
  }
  live(recipient) {
    const queue = this.queues.get(recipient);
    if (!queue)
      return [];
    const cutoff = this.now() - this.ttlMs;
    return queue.filter((item) => item.receivedAt >= cutoff);
  }
}

// src/relay/upstash.ts
class UpstashError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "UpstashError";
  }
}

class UpstashStore {
  base;
  token;
  ttlSeconds;
  maxQueue;
  prefix;
  http;
  constructor(options) {
    if (!options.url)
      throw new UpstashError("UPSTASH_REDIS_REST_URL \uC774 \uBE44\uC5B4 \uC788\uB2E4");
    if (!options.token)
      throw new UpstashError("UPSTASH_REDIS_REST_TOKEN \uC774 \uBE44\uC5B4 \uC788\uB2E4");
    this.base = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.ttlSeconds = Math.max(1, Math.ceil((options.ttlMs ?? DEFAULT_TTL_MS) / 1000));
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.prefix = options.prefix ?? "acm:q:";
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async push(recipient, item) {
    const key = this.key(recipient);
    const payload = encode(item);
    await this.exec([
      ["RPUSH", key, payload],
      ["LTRIM", key, String(-this.maxQueue), "-1"],
      ["EXPIRE", key, String(this.ttlSeconds)]
    ]);
  }
  async drain(recipient, limit) {
    if (limit <= 0)
      return [];
    const raw = await this.command(["LPOP", this.key(recipient), String(limit)]);
    if (raw === null || raw === undefined)
      return [];
    if (!Array.isArray(raw)) {
      throw new UpstashError(`LPOP \uC774 \uBC30\uC5F4\uC774 \uC544\uB2CC \uAC83\uC744 \uB3CC\uB824\uC92C\uB2E4: ${typeof raw}`);
    }
    return raw.map(decodeItem);
  }
  async depth(recipient) {
    const raw = await this.command(["LLEN", this.key(recipient)]);
    return typeof raw === "number" ? raw : 0;
  }
  key(recipient) {
    return this.prefix + recipient;
  }
  async command(args) {
    const body = await this.request("", args);
    if (Array.isArray(body))
      throw new UpstashError("\uB2E8\uC77C \uBA85\uB839\uC5D0 \uBC30\uC5F4 \uC751\uB2F5\uC774 \uC654\uB2E4");
    const one = body;
    if (one.error)
      throw new UpstashError(one.error);
    return one.result;
  }
  async exec(commands) {
    const body = await this.request("/multi-exec", commands);
    if (!Array.isArray(body)) {
      const one = body;
      throw new UpstashError(one.error ?? "multi-exec \uC751\uB2F5\uC774 \uBC30\uC5F4\uC774 \uC544\uB2C8\uB2E4");
    }
    for (const entry of body) {
      if (entry.error)
        throw new UpstashError(entry.error);
    }
  }
  async request(path, payload) {
    let res;
    try {
      res = await this.http(this.base + path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw new UpstashError(`Upstash \uC5D0 \uB2FF\uC9C0 \uBABB\uD588\uB2E4: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new UpstashError(`Upstash \uAC00 \uC624\uB958\uB97C \uB3CC\uB824\uC92C\uB2E4 \u2014 \uC0C1\uD0DC ${res.status}: ${await res.text()}`, res.status);
    }
    return await res.json();
  }
}
function encode(item) {
  return `${item.receivedAt}:${base642(item.envelope)}`;
}
function decodeItem(raw) {
  if (typeof raw !== "string") {
    throw new UpstashError(`\uD050 \uD56D\uBAA9\uC774 \uBB38\uC790\uC5F4\uC774 \uC544\uB2C8\uB2E4: ${typeof raw}`);
  }
  const at = raw.indexOf(":");
  if (at < 0)
    throw new UpstashError("\uD050 \uD56D\uBAA9 \uD615\uC2DD\uC774 \uC5B4\uAE0B\uB09C\uB2E4 \u2014 \uAD6C\uBD84\uC790\uAC00 \uC5C6\uB2E4");
  const receivedAt = Number(raw.slice(0, at));
  if (!Number.isFinite(receivedAt)) {
    throw new UpstashError("\uD050 \uD56D\uBAA9\uC758 \uB3C4\uCC29 \uC2DC\uAC01\uC774 \uC22B\uC790\uAC00 \uC544\uB2C8\uB2E4");
  }
  return { receivedAt, envelope: fromBase64(raw.slice(at + 1)) };
}
function base642(bytes) {
  let s = "";
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(text) {
  const raw = atob(text);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function fromEnv(env, options = {}) {
  const { url, token } = credentials(env);
  if (!url || !token) {
    throw new UpstashError("Upstash \uC790\uACA9\uC774 \uC5C6\uB2E4 \u2014 UPSTASH_REDIS_REST_URL \uACFC UPSTASH_REDIS_REST_TOKEN \uC744 \uC124\uC815\uD55C\uB2E4. " + "(Vercel \uD1B5\uD569\uC774 KV_REST_API_URL/TOKEN \uC73C\uB85C \uB123\uC5C8\uB2E4\uBA74 \uADF8\uAC83\uB3C4 \uC77D\uB294\uB2E4.)");
  }
  return new UpstashStore({ ...options, url, token });
}
function hasUpstashCredentials(env) {
  const { url, token } = credentials(env);
  return Boolean(url && token);
}
function credentials(env) {
  return {
    url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN
  };
}

// node_modules/@tursodatabase/serverless/dist/index.js
var AsyncLock = class {
  constructor() {
    this.locked = false;
    this.queue = [];
  }
  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
};
var DatabaseError = class _DatabaseError extends Error {
  constructor(message, code, rawCode, cause) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.rawCode = rawCode;
    this.cause = cause;
    Object.setPrototypeOf(this, _DatabaseError.prototype);
  }
};
var TimeoutError = class _TimeoutError extends DatabaseError {
  constructor(message = "Query timed out", cause) {
    super(message, "TIMEOUT", undefined, cause);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, _TimeoutError.prototype);
  }
};
function toBase64(uint8) {
  return Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString("base64");
}
function encodeValue(value) {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Only finite numbers (not Infinity or NaN) can be passed as arguments");
    }
    if (Number.isSafeInteger(value)) {
      return { type: "integer", value: value.toString() };
    }
    return { type: "float", value };
  }
  if (typeof value === "bigint") {
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "boolean") {
    return { type: "integer", value: value ? "1" : "0" };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "blob", base64: toBase64(new Uint8Array(value)) };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: toBase64(value) };
  }
  return { type: "text", value: String(value) };
}
function decodeValue(value, safeIntegers = false) {
  switch (value.type) {
    case "null":
      return null;
    case "integer":
      if (safeIntegers) {
        return BigInt(value.value);
      }
      return parseInt(value.value, 10);
    case "float":
      return value.value;
    case "text":
      return value.value;
    case "blob":
      if (value.base64 !== undefined && value.base64 !== null) {
        let b64 = value.base64;
        while (b64.length % 4 !== 0) {
          b64 += "=";
        }
        const binaryString = atob(b64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0;i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return Buffer.from(bytes);
      }
      return Buffer.alloc(0);
    default:
      return null;
  }
}
var ENCRYPTION_KEY_HEADER = "x-turso-encryption-key";
function buildHeaders(ctx) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (ctx.authToken) {
    headers["Authorization"] = `Bearer ${ctx.authToken}`;
  }
  if (ctx.remoteEncryptionKey) {
    headers[ENCRYPTION_KEY_HEADER] = ctx.remoteEncryptionKey;
  }
  for (const [name, value] of Object.entries(ctx.requestHeaders ?? {})) {
    if (name.toLowerCase() === "host") {
      throw new DatabaseError("overwriting the 'Host' header is not supported");
    }
    headers[name] = value;
  }
  return headers;
}
function buildFetchOptions(ctx, body, signal) {
  return {
    method: "POST",
    headers: buildHeaders(ctx),
    body,
    signal
  };
}
function wrapAbortError(error) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw new TimeoutError("Query timed out");
  }
  throw error;
}
async function executeCursor(ctx, request, signal) {
  let response;
  try {
    response = await fetch(`${ctx.url}/v3/cursor`, buildFetchOptions(ctx, JSON.stringify(request), signal));
  } catch (error) {
    wrapAbortError(error);
  }
  if (!response.ok) {
    let errorMessage = `HTTP error! status: ${response.status}`;
    try {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody);
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {}
    throw new DatabaseError(errorMessage);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new DatabaseError("No response body");
  }
  const decoder = new TextDecoder;
  let buffer = "";
  let cursorResponse;
  try {
    while (!cursorResponse) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      const newlineIndex = buffer.indexOf(`
`);
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          cursorResponse = JSON.parse(line);
          break;
        }
      }
    }
  } catch (error) {
    reader.releaseLock();
    wrapAbortError(error);
  }
  if (!cursorResponse) {
    reader.releaseLock();
    throw new DatabaseError("No cursor response received");
  }
  async function* parseEntries() {
    try {
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf(`
`)) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield JSON.parse(line);
        }
      }
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (error) {
          wrapAbortError(error);
        }
        if (readResult.done)
          break;
        buffer += decoder.decode(readResult.value, { stream: true });
        while ((newlineIndex = buffer.indexOf(`
`)) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            yield JSON.parse(line);
          }
        }
      }
      if (buffer.trim()) {
        yield JSON.parse(buffer.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { response: cursorResponse, entries: parseEntries() };
}
async function executePipeline(ctx, request, signal) {
  let response;
  try {
    response = await fetch(`${ctx.url}/v3/pipeline`, buildFetchOptions(ctx, JSON.stringify(request), signal));
  } catch (error) {
    wrapAbortError(error);
  }
  if (!response.ok) {
    throw new DatabaseError(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}
function normalizeArgs(args) {
  if (args === undefined)
    return [];
  if (Array.isArray(args))
    return args;
  if (args !== null && typeof args === "object" && args.constructor === Object) {
    return args;
  }
  return [args];
}
function isQueryOptions(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) && (Object.prototype.hasOwnProperty.call(value, "queryTimeout") || Object.prototype.hasOwnProperty.call(value, "requestHeaders"));
}
function splitBindParameters(bindParameters) {
  if (bindParameters.length === 0) {
    return { params: undefined, queryOptions: undefined };
  }
  if (isQueryOptions(bindParameters[bindParameters.length - 1])) {
    if (bindParameters.length === 1) {
      return { params: undefined, queryOptions: bindParameters[0] };
    }
    return {
      params: bindParameters.length === 2 ? bindParameters[0] : bindParameters.slice(0, -1),
      queryOptions: bindParameters[bindParameters.length - 1]
    };
  }
  return {
    params: bindParameters.length === 1 ? bindParameters[0] : bindParameters,
    queryOptions: undefined
  };
}
function encodeSqlArgs(args = []) {
  let positionalArgs = [];
  let namedArgs = [];
  if (Array.isArray(args)) {
    positionalArgs = args.map(encodeValue);
  } else {
    const keys = Object.keys(args);
    const isNumericKeys = keys.length > 0 && keys.every((key) => /^\d+$/.test(key));
    if (isNumericKeys) {
      const sortedKeys = keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      const maxIndex = parseInt(sortedKeys[sortedKeys.length - 1], 10);
      positionalArgs = new Array(maxIndex);
      for (const key of sortedKeys) {
        const index = parseInt(key, 10) - 1;
        positionalArgs[index] = encodeValue(args[key]);
      }
      for (let i = 0;i < positionalArgs.length; i++) {
        if (positionalArgs[i] === undefined) {
          positionalArgs[i] = { type: "null" };
        }
      }
    } else {
      namedArgs = Object.entries(args).map(([name, value]) => ({
        name,
        value: encodeValue(value)
      }));
    }
  }
  return { args: positionalArgs, namedArgs };
}
function normalizeBatchMode(mode) {
  switch (String(mode).toLowerCase()) {
    case "write":
      return "IMMEDIATE";
    case "read":
    case "deferred":
      return "DEFERRED";
    case "immediate":
      return "IMMEDIATE";
    case "exclusive":
      return "EXCLUSIVE";
    case "concurrent":
      return "CONCURRENT";
    default:
      return String(mode).toUpperCase();
  }
}
function normalizeUrl(url) {
  return url.replace(/^(libsql|turso):\/\//, "https://").replace(/\/+$/, "");
}
function isValidIdentifier(str) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}
var Session = class _Session {
  constructor(config) {
    this.baton = null;
    this.autocommit = true;
    for (const name of Object.keys(config.requestHeaders ?? {})) {
      if (name.toLowerCase() === "host") {
        throw new DatabaseError("overwriting the 'Host' header is not supported");
      }
    }
    this.config = config;
    this.baseUrl = normalizeUrl(config.url);
  }
  httpContext(queryOptions) {
    let requestHeaders = this.config.requestHeaders;
    if (queryOptions?.requestHeaders) {
      requestHeaders = { ...requestHeaders, ...queryOptions.requestHeaders };
    }
    return {
      url: this.baseUrl,
      authToken: this.config.authToken,
      remoteEncryptionKey: this.config.remoteEncryptionKey,
      requestHeaders
    };
  }
  get inTransaction() {
    return !this.autocommit;
  }
  updateAutocommit(response) {
    if (!response.results) {
      return;
    }
    for (const result of response.results) {
      if (result.type === "ok" && result.response?.type === "get_autocommit" && typeof result.response.is_autocommit === "boolean") {
        this.autocommit = result.response.is_autocommit;
        return;
      }
    }
  }
  createAbortSignal(queryOptions) {
    const timeout = queryOptions?.queryTimeout ?? this.config.defaultQueryTimeout;
    if (timeout != null && timeout > 0) {
      return AbortSignal.timeout(timeout);
    }
    return;
  }
  async describe(sql, queryOptions) {
    const request = {
      baton: this.baton,
      requests: [
        { type: "describe", sql },
        { type: "get_autocommit" }
      ]
    };
    let response;
    try {
      response = await executePipeline(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = normalizeUrl(response.base_url);
    }
    this.updateAutocommit(response);
    if (response.results && response.results[0]) {
      const result = response.results[0];
      if (result.type === "error") {
        throw new DatabaseError(result.error?.message || "Describe execution failed", result.error?.code);
      }
      if (result.response?.type === "describe" && result.response.result) {
        return result.response.result;
      }
    }
    throw new DatabaseError("Unexpected describe response");
  }
  async execute(sql, args = [], safeIntegers = false, queryOptions) {
    const { response, entries } = await this.executeRaw(sql, args, queryOptions);
    const result = await this.processCursorEntries(entries, safeIntegers);
    return result;
  }
  static autocommitProbeStep() {
    return {
      stmt: { sql: "SELECT 1", args: [], named_args: [], want_rows: false },
      condition: { type: "is_autocommit" }
    };
  }
  async* trackAutocommit(entries, probeIdx, queryOptions) {
    let sawProbe = false;
    let unreliable = false;
    let completed = false;
    try {
      for await (const entry of entries) {
        if (entry.type === "step_begin" && entry.step === probeIdx) {
          sawProbe = true;
          continue;
        }
        if (sawProbe && (entry.type === "row" || entry.type === "step_end")) {
          continue;
        }
        if (entry.type === "error" || entry.type === "step_error" && entry.step === probeIdx) {
          unreliable = true;
          if (entry.type === "step_error") {
            continue;
          }
        }
        yield entry;
      }
      completed = true;
    } finally {
      if (completed && !unreliable) {
        this.autocommit = sawProbe;
      } else {
        await this.refreshAutocommit(queryOptions);
      }
    }
  }
  async executeRaw(sql, args = [], queryOptions) {
    const encodedArgs = encodeSqlArgs(args);
    const request = {
      baton: this.baton,
      batch: {
        steps: [{
          stmt: {
            sql,
            args: encodedArgs.args,
            named_args: encodedArgs.namedArgs,
            want_rows: true
          }
        }, _Session.autocommitProbeStep()]
      }
    };
    let result;
    try {
      result = await executeCursor(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    const { response, entries } = result;
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = normalizeUrl(response.base_url);
    }
    return { response, entries: this.trackAutocommit(entries, 1, queryOptions) };
  }
  async refreshAutocommit(queryOptions) {
    const request = {
      baton: this.baton,
      requests: [{ type: "get_autocommit" }]
    };
    let response;
    try {
      response = await executePipeline(this.httpContext(), request, this.createAbortSignal(queryOptions));
    } catch {
      this.baton = null;
      this.autocommit = true;
      return;
    }
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = normalizeUrl(response.base_url);
    }
    this.updateAutocommit(response);
  }
  async processCursorEntries(entries, safeIntegers = false) {
    let columns = [];
    let columnTypes = [];
    let rows = [];
    let rowsAffected = 0;
    let lastInsertRowid;
    for await (const entry of entries) {
      switch (entry.type) {
        case "step_begin":
          if (entry.cols) {
            columns = entry.cols.map((col) => col.name);
            columnTypes = entry.cols.map((col) => col.decltype || "");
          }
          break;
        case "row":
          if (entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, safeIntegers));
            const rowObject = this.createRowObject(decodedRow, columns);
            rows.push(rowObject);
          }
          break;
        case "step_end":
          if (entry.affected_row_count !== undefined) {
            rowsAffected = entry.affected_row_count;
          }
          if (entry.last_insert_rowid !== undefined && entry.last_insert_rowid !== null) {
            lastInsertRowid = typeof entry.last_insert_rowid === "number" ? entry.last_insert_rowid : parseInt(entry.last_insert_rowid, 10);
          }
          break;
        case "step_error":
        case "error":
          throw new DatabaseError(entry.error?.message || "SQL execution failed", entry.error?.code);
      }
    }
    return {
      columns,
      columnTypes,
      rows,
      rowsAffected,
      lastInsertRowid
    };
  }
  createRowObject(values, columns) {
    const row = [...values];
    columns.forEach((column, index) => {
      if (column && isValidIdentifier(column)) {
        Object.defineProperty(row, column, {
          value: values[index],
          enumerable: false,
          writable: false,
          configurable: true
        });
      }
    });
    return row;
  }
  createObjectRow(values, columns) {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  }
  async batch(statements, mode, queryOptions, safeIntegers = false, raw = false) {
    const userSteps = statements.map((statement) => {
      if (typeof statement === "string") {
        return {
          stmt: { sql: statement, args: [], named_args: [], want_rows: true }
        };
      }
      const encodedArgs = encodeSqlArgs(statement.args ?? []);
      return {
        stmt: {
          sql: statement.sql,
          args: encodedArgs.args,
          named_args: encodedArgs.namedArgs,
          want_rows: true
        }
      };
    });
    let steps;
    let firstUserStepIdx = 0;
    let lastUserStepIdx = userSteps.length - 1;
    let beginIdx = -1;
    let commitIdx = -1;
    let rollbackIdx = -1;
    if (mode === undefined) {
      steps = userSteps;
    } else {
      beginIdx = 0;
      firstUserStepIdx = 1;
      lastUserStepIdx = userSteps.length;
      commitIdx = lastUserStepIdx + 1;
      rollbackIdx = commitIdx + 1;
      steps = [
        { stmt: { sql: `BEGIN ${normalizeBatchMode(mode)}`, args: [], named_args: [], want_rows: false } },
        ...userSteps.map((step, i) => ({
          ...step,
          condition: { type: "ok", step: i === 0 ? beginIdx : firstUserStepIdx + i - 1 }
        })),
        {
          stmt: { sql: "COMMIT", args: [], named_args: [], want_rows: false },
          condition: { type: "ok", step: lastUserStepIdx }
        },
        {
          stmt: { sql: "ROLLBACK", args: [], named_args: [], want_rows: false },
          condition: {
            type: "and",
            conds: [
              { type: "ok", step: beginIdx },
              { type: "not", cond: { type: "ok", step: commitIdx } }
            ]
          }
        }
      ];
    }
    const probeIdx = steps.length;
    const request = {
      baton: this.baton,
      batch: { steps: [...steps, _Session.autocommitProbeStep()] }
    };
    let batchResult;
    try {
      batchResult = await executeCursor(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    const { response, entries } = batchResult;
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = normalizeUrl(response.base_url);
    }
    const results = userSteps.map(() => ({
      columns: [],
      columnTypes: [],
      rows: [],
      rowsAffected: 0
    }));
    let deferredError = null;
    let currentResultIdx;
    let nextNonAtomicIdx = 0;
    const stepToResultIdx = (step) => {
      if (mode === undefined) {
        return step ?? nextNonAtomicIdx;
      }
      if (step !== undefined && step >= firstUserStepIdx && step <= lastUserStepIdx) {
        return step - firstUserStepIdx;
      }
      return;
    };
    for await (const entry of this.trackAutocommit(entries, probeIdx, queryOptions)) {
      if (deferredError !== null && entry.type !== "error") {
        continue;
      }
      switch (entry.type) {
        case "step_begin":
          currentResultIdx = stepToResultIdx(entry.step);
          if (currentResultIdx !== undefined && currentResultIdx < results.length && entry.cols) {
            results[currentResultIdx].columns = entry.cols.map((col) => col.name);
            results[currentResultIdx].columnTypes = entry.cols.map((col) => col.decltype || "");
          }
          break;
        case "row":
          if (currentResultIdx !== undefined && currentResultIdx < results.length && entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, safeIntegers));
            const row = raw ? decodedRow : this.createObjectRow(decodedRow, results[currentResultIdx].columns);
            results[currentResultIdx].rows.push(row);
          }
          break;
        case "step_end": {
          let idx = currentResultIdx;
          if (idx === undefined && mode === undefined) {
            idx = nextNonAtomicIdx;
          }
          if (idx !== undefined && idx < results.length) {
            if (entry.affected_row_count !== undefined) {
              results[idx].rowsAffected = results[idx].columns.length > 0 ? 0 : entry.affected_row_count;
            }
          }
          if (mode === undefined && idx !== undefined) {
            nextNonAtomicIdx = idx + 1;
          }
          currentResultIdx = undefined;
          break;
        }
        case "step_error":
          if (deferredError === null && entry.step !== rollbackIdx) {
            deferredError = new DatabaseError(entry.error?.message || "Batch execution failed", entry.error?.code);
          }
          currentResultIdx = undefined;
          break;
        case "error":
          throw new DatabaseError(entry.error?.message || "Batch execution failed", entry.error?.code);
      }
    }
    if (deferredError !== null) {
      throw deferredError;
    }
    return results;
  }
  async sequence(sql, queryOptions) {
    const request = {
      baton: this.baton,
      requests: [
        { type: "sequence", sql },
        { type: "get_autocommit" }
      ]
    };
    let seqResponse;
    try {
      seqResponse = await executePipeline(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    this.baton = seqResponse.baton;
    if (seqResponse.base_url) {
      this.baseUrl = normalizeUrl(seqResponse.base_url);
    }
    this.updateAutocommit(seqResponse);
    if (seqResponse.results && seqResponse.results[0]) {
      const result = seqResponse.results[0];
      if (result.type === "error") {
        throw new DatabaseError(result.error?.message || "Sequence execution failed", result.error?.code);
      }
    }
  }
  async close() {
    if (this.baton) {
      try {
        const request = {
          baton: this.baton,
          requests: [{
            type: "close"
          }]
        };
        await executePipeline(this.httpContext(), request);
      } catch {}
    }
    this.baton = null;
    this.baseUrl = "";
    this.autocommit = true;
  }
};
function createExpandedRow(row, columns) {
  const expanded = {};
  columns.forEach((column, index) => {
    expanded[column] = row[index];
  });
  return expanded;
}
var Statement = class _Statement {
  constructor(sessionConfig, sql, columns) {
    this.presentationMode = "expanded";
    this.safeIntegerMode = false;
    this.session = new Session(sessionConfig);
    this.sql = sql;
    this.columnMetadata = columns || [];
  }
  static fromSession(session, sql, columns, execLock) {
    const stmt = Object.create(_Statement.prototype);
    stmt.session = session;
    stmt.sql = sql;
    stmt.columnMetadata = columns || [];
    stmt.presentationMode = "expanded";
    stmt.safeIntegerMode = false;
    stmt.execLock = execLock;
    return stmt;
  }
  get reader() {
    return this.columnMetadata.length > 0;
  }
  raw(raw) {
    this.presentationMode = raw === false ? "expanded" : "raw";
    return this;
  }
  pluck(pluck) {
    this.presentationMode = pluck === false ? "expanded" : "pluck";
    return this;
  }
  safeIntegers(toggle) {
    this.safeIntegerMode = toggle === false ? false : true;
    return this;
  }
  columns() {
    return this.columnMetadata.map((col) => ({
      name: col.name,
      type: col.decltype
    }));
  }
  async withLock(fn) {
    if (!this.execLock) {
      return await fn();
    }
    await this.execLock.acquire();
    try {
      return await fn();
    } finally {
      this.execLock.release();
    }
  }
  async run(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    });
  }
  async get(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      const row = result.rows[0];
      if (!row) {
        return;
      }
      if (this.presentationMode === "pluck") {
        return row[0];
      }
      if (this.presentationMode === "raw") {
        return [...row];
      }
      return createExpandedRow(row, result.columns);
    });
  }
  async all(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      if (this.presentationMode === "pluck") {
        return result.rows.map((row) => row[0]);
      }
      if (this.presentationMode === "raw") {
        return result.rows.map((row) => [...row]);
      }
      return result.rows.map((row) => createExpandedRow(row, result.columns));
    });
  }
  async* iterate(args, queryOptions) {
    if (this.execLock) {
      const rows = await this.all(args, queryOptions);
      for (const row of rows) {
        yield row;
      }
      return;
    }
    const normalizedArgs = normalizeArgs(args);
    const { entries } = await this.session.executeRaw(this.sql, normalizedArgs, queryOptions);
    let columns = [];
    for await (const entry of entries) {
      switch (entry.type) {
        case "step_begin":
          if (entry.cols) {
            columns = entry.cols.map((col) => col.name);
          }
          break;
        case "row":
          if (entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, this.safeIntegerMode));
            if (this.presentationMode === "pluck") {
              yield decodedRow[0];
            } else if (this.presentationMode === "raw") {
              yield decodedRow;
            } else {
              yield createExpandedRow(decodedRow, columns);
            }
          }
          break;
        case "step_error":
        case "error":
          throw new DatabaseError(entry.error?.message || "SQL execution failed");
      }
    }
  }
};
function normalizeBatchOptions(options) {
  if (options != null && typeof options === "object") {
    return {
      mode: options.mode,
      raw: options.raw === true
    };
  }
  return {
    mode: options,
    raw: false
  };
}
function toResultSet(result) {
  return {
    columns: result.columns ?? [],
    columnTypes: result.columnTypes ?? [],
    rows: result.rows ?? [],
    rowsAffected: result.rowsAffected ?? 0
  };
}
var Connection = class {
  constructor(config) {
    this.isOpen = true;
    this.defaultSafeIntegerMode = false;
    this.execLock = new AsyncLock;
    if (!config.url) {
      throw new Error("invalid config: url is required");
    }
    this.config = config;
    this.session = new Session(config);
    Object.defineProperty(this, "inTransaction", {
      get: () => this.session.inTransaction,
      enumerable: true
    });
  }
  get inTransaction() {
    return this.session.inTransaction;
  }
  async prepare(sql) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    let description;
    try {
      description = await this.session.describe(sql);
    } finally {
      this.execLock.release();
    }
    const stmt = Statement.fromSession(this.session, sql, description.cols, this.execLock);
    if (this.defaultSafeIntegerMode) {
      stmt.safeIntegers(true);
    }
    return stmt;
  }
  async run(sql, ...bindParameters) {
    if (!this.isOpen)
      throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    } finally {
      this.execLock.release();
    }
  }
  async get(sql, ...bindParameters) {
    if (!this.isOpen)
      throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      const row = result.rows[0];
      if (!row)
        return;
      return createExpandedRow(row, result.columns);
    } finally {
      this.execLock.release();
    }
  }
  async all(sql, ...bindParameters) {
    if (!this.isOpen)
      throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return result.rows.map((row) => createExpandedRow(row, result.columns));
    } finally {
      this.execLock.release();
    }
  }
  async* iterate(sql, ...bindParameters) {
    for (const row of await this.all(sql, ...bindParameters))
      yield row;
  }
  async exec(sql, queryOptions) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      return await this.session.sequence(sql, queryOptions);
    } finally {
      this.execLock.release();
    }
  }
  async batch(statements, options, queryOptions) {
    if (!Array.isArray(statements)) {
      throw new TypeError("Expected first argument to be an array of statements");
    }
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      const { mode, raw } = normalizeBatchOptions(options);
      const effectiveMode = this.session.inTransaction ? undefined : mode;
      const results = await this.session.batch(statements, effectiveMode, queryOptions, this.defaultSafeIntegerMode, raw);
      return results.map((result) => toResultSet(result));
    } finally {
      this.execLock.release();
    }
  }
  async pragma(pragma, queryOptions) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      const sql = `PRAGMA ${pragma}`;
      return await this.session.execute(sql, [], false, queryOptions);
    } finally {
      this.execLock.release();
    }
  }
  defaultSafeIntegers(toggle) {
    this.defaultSafeIntegerMode = toggle === false ? false : true;
  }
  transaction(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("Expected first argument to be a function");
    }
    const db = this;
    const wrapTxn = (mode) => {
      return async (...bindParameters) => {
        await db.exec("BEGIN " + mode);
        try {
          const result = await fn(...bindParameters);
          await db.exec("COMMIT");
          return result;
        } catch (err) {
          await db.exec("ROLLBACK");
          throw err;
        }
      };
    };
    const properties = {
      default: { value: wrapTxn("") },
      deferred: { value: wrapTxn("DEFERRED") },
      concurrent: { value: wrapTxn("CONCURRENT") },
      immediate: { value: wrapTxn("IMMEDIATE") },
      exclusive: { value: wrapTxn("EXCLUSIVE") },
      database: { value: this, enumerable: true }
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.concurrent.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }
  transactionAsync(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("Expected first argument to be a function");
    }
    if (fn.length === 0) {
      throw new TypeError("transactionAsync() callbacks receive a Transaction handle as their first argument and must declare it: db.transactionAsync(async (tx, ...args) => { await tx.run(...) }).");
    }
    const db = this;
    const wrapTxn = (mode) => {
      return async (...bindParameters) => {
        if (!db.isOpen) {
          throw new TypeError("The database connection is not open");
        }
        const session = new Session(db.config);
        const txn = new Transaction(session, db.defaultSafeIntegerMode);
        try {
          await txn.exec("BEGIN " + mode);
          try {
            const result = await fn(txn, ...bindParameters);
            await txn.exec("COMMIT");
            return result;
          } catch (err) {
            try {
              await txn.exec("ROLLBACK");
            } catch {}
            throw err;
          }
        } finally {
          txn.finish();
          await session.close();
        }
      };
    };
    const properties = {
      default: { value: wrapTxn("") },
      deferred: { value: wrapTxn("DEFERRED") },
      concurrent: { value: wrapTxn("CONCURRENT") },
      immediate: { value: wrapTxn("IMMEDIATE") },
      exclusive: { value: wrapTxn("EXCLUSIVE") },
      database: { value: this, enumerable: true }
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.concurrent.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }
  async close() {
    this.isOpen = false;
    await this.session.close();
  }
  async reconnect() {
    try {
      if (this.isOpen) {
        await this.close();
      }
    } finally {
      this.session = new Session(this.config);
      this.isOpen = true;
    }
  }
};
var Transaction = class {
  constructor(session, defaultSafeIntegerMode) {
    this.active = true;
    this.session = session;
    this.defaultSafeIntegerMode = defaultSafeIntegerMode;
    const lock = new AsyncLock;
    this.gate = {
      acquire: async () => {
        this.assertActive();
        await lock.acquire();
      },
      release: () => {
        lock.release();
      }
    };
  }
  async withGate(fn) {
    await this.gate.acquire();
    try {
      return await fn();
    } finally {
      this.gate.release();
    }
  }
  get open() {
    return this.active;
  }
  assertActive() {
    if (!this.active) {
      throw new TypeError("The transaction has already completed");
    }
  }
  finish() {
    this.active = false;
  }
  async prepare(sql) {
    const description = await this.withGate(() => this.session.describe(sql));
    const stmt = Statement.fromSession(this.session, sql, description.cols, this.gate);
    if (this.defaultSafeIntegerMode) {
      stmt.safeIntegers(true);
    }
    return stmt;
  }
  async run(sql, ...bindParameters) {
    const { params, queryOptions } = splitBindParameters(bindParameters);
    return await this.withGate(async () => {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    });
  }
  async get(sql, ...bindParameters) {
    const { params, queryOptions } = splitBindParameters(bindParameters);
    return await this.withGate(async () => {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      const row = result.rows[0];
      if (!row)
        return;
      return createExpandedRow(row, result.columns);
    });
  }
  async all(sql, ...bindParameters) {
    const { params, queryOptions } = splitBindParameters(bindParameters);
    return await this.withGate(async () => {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return result.rows.map((row) => createExpandedRow(row, result.columns));
    });
  }
  async* iterate(sql, ...bindParameters) {
    for (const row of await this.all(sql, ...bindParameters))
      yield row;
  }
  async execute(sql, args, queryOptions) {
    return await this.withGate(() => this.session.execute(sql, args || [], this.defaultSafeIntegerMode, queryOptions));
  }
  async exec(sql, queryOptions) {
    return await this.withGate(() => this.session.sequence(sql, queryOptions));
  }
  async batch(statements, options, queryOptions) {
    if (!Array.isArray(statements)) {
      throw new TypeError("Expected first argument to be an array of statements");
    }
    const { raw } = normalizeBatchOptions(options);
    return await this.withGate(async () => {
      const results = await this.session.batch(statements, undefined, queryOptions, this.defaultSafeIntegerMode, raw);
      return results.map((result) => toResultSet(result));
    });
  }
};
function connect(config) {
  return new Connection(config);
}

// src/relay/turso.ts
var TABLE = "acm_relay_queue";
var INDEX = "acm_relay_queue_recipient_idx";

class TursoError extends Error {
  cause;
  constructor(message, cause) {
    super(message, { cause });
    this.name = "TursoError";
    this.cause = cause;
  }
}

class TursoStore {
  client;
  ttlMs;
  maxQueue;
  namespace;
  now;
  schemaReady;
  constructor(options) {
    if (!options.url?.trim())
      throw new TursoError("TURSO_DATABASE_URL \uC774 \uBE44\uC5B4 \uC788\uB2E4");
    if (!options.token?.trim())
      throw new TursoError("TURSO_AUTH_TOKEN \uC774 \uBE44\uC5B4 \uC788\uB2E4");
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new TursoError("ttlMs \uB294 \uC591\uC218\uC5EC\uC57C \uD55C\uB2E4");
    if (!Number.isInteger(maxQueue) || maxQueue <= 0)
      throw new TursoError("maxQueue \uB294 \uC591\uC758 \uC815\uC218\uC5EC\uC57C \uD55C\uB2E4");
    const namespace = options.namespace?.trim() || "default";
    this.client = options.client ?? connect({ url: options.url.trim(), authToken: options.token.trim() });
    this.ttlMs = ttlMs;
    this.maxQueue = maxQueue;
    this.namespace = namespace;
    this.now = options.now ?? Date.now;
  }
  async push(recipient, item) {
    const receivedAt = finiteNumber(item.receivedAt, "receivedAt");
    const expiresAt = receivedAt + this.ttlMs;
    await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, this.now()]
      },
      {
        sql: `INSERT INTO ${TABLE} (namespace, recipient, received_at, expires_at, envelope)
              VALUES (?, ?, ?, ?, ?)`,
        args: [this.namespace, recipient, receivedAt, expiresAt, item.envelope]
      },
      {
        sql: `DELETE FROM ${TABLE}
              WHERE namespace = ? AND recipient = ?
                AND id NOT IN (
                  SELECT id FROM ${TABLE}
                   WHERE namespace = ? AND recipient = ?
                   ORDER BY id DESC
                   LIMIT ?
                )`,
        args: [this.namespace, recipient, this.namespace, recipient, this.maxQueue]
      }
    ]);
  }
  async drain(recipient, limit) {
    const count = integerLimit(limit);
    if (count <= 0)
      return [];
    const now = this.now();
    const results = await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, now]
      },
      {
        sql: `DELETE FROM ${TABLE}
              WHERE id IN (
                SELECT id FROM ${TABLE}
                 WHERE namespace = ? AND recipient = ? AND expires_at > ?
                 ORDER BY id ASC
                 LIMIT ?
              )
              RETURNING received_at, envelope`,
        args: [this.namespace, recipient, now, count]
      }
    ]);
    return rowsOf(results[1], "drain").map((row) => ({
      receivedAt: finiteNumber(row.received_at, "received_at"),
      envelope: bytes(row.envelope)
    }));
  }
  async depth(recipient) {
    const now = this.now();
    const results = await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, now]
      },
      {
        sql: `SELECT COUNT(*) AS count FROM ${TABLE}
               WHERE namespace = ? AND recipient = ? AND expires_at > ?`,
        args: [this.namespace, recipient, now]
      }
    ]);
    const row = rowsOf(results[1], "depth")[0];
    return row === undefined ? 0 : finiteNumber(row.count, "count");
  }
  async atomic(statements) {
    await this.ensureSchema();
    try {
      return await this.client.batch(statements, "immediate");
    } catch (e) {
      throw wrap("\uC6D0\uC790\uC801 \uBC30\uCE58", e);
    }
  }
  async ensureSchema() {
    if (this.schemaReady !== undefined)
      return await this.schemaReady;
    const work = this.client.batch([
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             namespace TEXT NOT NULL,
             recipient TEXT NOT NULL,
             received_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL,
             envelope BLOB NOT NULL
           )`,
      `CREATE INDEX IF NOT EXISTS ${INDEX}
             ON ${TABLE} (namespace, recipient, id)`
    ], "immediate").then(() => {
      return;
    });
    this.schemaReady = work.catch((e) => {
      this.schemaReady = undefined;
      throw wrap("\uC2A4\uD0A4\uB9C8 \uC900\uBE44", e);
    });
    return await this.schemaReady;
  }
}
function fromEnv2(env, options = {}) {
  const url = env.TURSO_DATABASE_URL?.trim();
  const token = env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) {
    throw new TursoError("Turso \uC790\uACA9\uC774 \uC5C6\uB2E4 \u2014 TURSO_DATABASE_URL \uACFC TURSO_AUTH_TOKEN \uC744 \uC124\uC815\uD55C\uB2E4.");
  }
  return new TursoStore({ ...options, url, token });
}
function hasTursoCredentials(env) {
  return Boolean(env.TURSO_DATABASE_URL?.trim() && env.TURSO_AUTH_TOKEN?.trim());
}
function hasAnyTursoCredentials(env) {
  return Boolean(env.TURSO_DATABASE_URL?.trim() || env.TURSO_AUTH_TOKEN?.trim());
}
function rowsOf(result, action) {
  if (result === undefined || !Array.isArray(result.rows)) {
    throw new TursoError(`Turso ${action} \uC751\uB2F5\uC5D0 \uD589 \uBAA9\uB85D\uC774 \uC5C6\uB2E4`);
  }
  return result.rows.filter((row) => typeof row === "object" && row !== null);
}
function finiteNumber(value, label) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new TursoError(`Turso ${label} \uC774 \uC22B\uC790\uAC00 \uC544\uB2C8\uB2E4`);
  }
  return number;
}
function integerLimit(value) {
  if (!Number.isFinite(value))
    throw new TursoError("drain limit \uC774 \uC720\uD55C\uD55C \uC22B\uC790\uAC00 \uC544\uB2C8\uB2E4");
  return Math.max(0, Math.floor(value));
}
function bytes(value) {
  if (value instanceof Uint8Array)
    return new Uint8Array(value);
  if (value instanceof ArrayBuffer)
    return new Uint8Array(value.slice(0));
  throw new TursoError(`Turso envelope \uC774 BLOB \uC774 \uC544\uB2C8\uB2E4: ${typeof value}`);
}
function wrap(action, cause) {
  if (cause instanceof TursoError)
    return cause;
  return new TursoError(`Turso ${action} \uC2E4\uD328: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
}

// src/relay/select-store.ts
function selectStore(env, limits) {
  const requested = requestedProvider(env);
  if (requested !== undefined)
    return makeStore(requested, env, limits);
  if (hasAnyTursoCredentials(env) && !hasTursoCredentials(env)) {
    throw new Error("Turso \uC790\uACA9\uC774 \uBD88\uC644\uC804\uD558\uB2E4 \u2014 TURSO_DATABASE_URL \uACFC TURSO_AUTH_TOKEN \uC744 \uD568\uAED8 \uC124\uC815\uD55C\uB2E4.");
  }
  if (hasAnyUpstashCredentials(env) && !hasUpstashCredentials(env)) {
    throw new Error("Upstash \uC790\uACA9\uC774 \uBD88\uC644\uC804\uD558\uB2E4 \u2014 UPSTASH_REDIS_REST_URL \uACFC UPSTASH_REDIS_REST_TOKEN \uC744 \uD568\uAED8 \uC124\uC815\uD55C\uB2E4. " + "(Vercel \uD1B5\uD569\uC758 KV_REST_API_URL/TOKEN \uB3C4 \uC9C0\uC6D0\uD55C\uB2E4.)");
  }
  const available = [];
  if (hasTursoCredentials(env))
    available.push("turso");
  if (hasUpstashCredentials(env))
    available.push("upstash");
  if (available.length > 1) {
    throw new Error(`\uC800\uC7A5\uC18C \uC790\uACA9\uC774 \uB458 \uB2E4 \uC788\uB2E4 (${available.join(", ")}) \u2014 \uC5B4\uB290 DB \uB97C \uC4F8\uC9C0 ACM_RELAY_STORE=turso \uB610\uB294 upstash \uB85C \uBA85\uC2DC\uD55C\uB2E4.`);
  }
  if (available.length === 1)
    return makeStore(available[0], env, limits);
  if (env.VERCEL) {
    throw new Error("\uC11C\uBC84\uB9AC\uC2A4\uC5D0\uC11C \uBA54\uBAA8\uB9AC \uC800\uC7A5\uC18C\uB85C \uB728\uC9C0 \uC54A\uB294\uB2E4 \u2014 \uC778\uC2A4\uD134\uC2A4\uB9C8\uB2E4 \uBA54\uBAA8\uB9AC\uAC00 \uAC08\uB824 \uBD09\uD22C\uAC00 \uC870\uC6A9\uD788 \uC0AC\uB77C\uC9C4\uB2E4. " + "ACM_RELAY_STORE=turso \uC640 TURSO_DATABASE_URL/TURSO_AUTH_TOKEN, \uB610\uB294 " + "ACM_RELAY_STORE=upstash \uC640 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN \uC744 \uC124\uC815\uD55C\uB2E4. " + "(Vercel \uD1B5\uD569\uC774 KV_REST_API_URL/TOKEN \uC73C\uB85C \uB123\uC5C8\uB2E4\uBA74 \uADF8\uAC83\uB3C4 \uC77D\uB294\uB2E4.)");
  }
  return makeStore("memory", env, limits);
}
function requestedProvider(env) {
  const raw = env.ACM_RELAY_STORE?.trim().toLowerCase();
  if (!raw)
    return;
  if (raw === "memory" || raw === "local")
    return "memory";
  if (raw === "turso" || raw === "upstash")
    return raw;
  throw new Error(`ACM_RELAY_STORE \uAC12\uC774 \uC798\uBABB\uB410\uB2E4: '${raw}' \u2014 memory(local)\xB7turso\xB7upstash \uC911 \uD558\uB098\uB97C \uC4F4\uB2E4.`);
}
function makeStore(provider, env, limits) {
  if (provider === "memory") {
    if (env.VERCEL) {
      throw new Error("ACM_RELAY_STORE=memory \uB294 \uC11C\uBC84\uB9AC\uC2A4\uC5D0\uC11C \uC4F8 \uC218 \uC5C6\uB2E4 \u2014 \uB85C\uCEEC \uB9B4\uB808\uC774\uC5D0\uC11C\uB9CC \uC120\uD0DD\uD55C\uB2E4. " + "\uC11C\uBC84\uB9AC\uC2A4\uB294 ACM_RELAY_STORE=turso \uB610\uB294 ACM_RELAY_STORE=upstash \uB97C \uC4F4\uB2E4.");
    }
    return {
      store: new MemoryStore({ ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
      provider,
      durable: false
    };
  }
  if (provider === "turso") {
    return {
      store: fromEnv2(env, { ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
      provider,
      durable: true
    };
  }
  return {
    store: fromEnv(env, { ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
    provider,
    durable: true
  };
}
function hasAnyUpstashCredentials(env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_URL?.trim() || env.KV_REST_API_TOKEN?.trim());
}

// src/relay/serve.ts
var DEFAULT_PORT = 8787;
var USAGE = `agent-channel-mesh \uB9B4\uB808\uC774

  bun run src/server.ts --port ${DEFAULT_PORT}

  --port <n>       \uAE30\uBCF8 ${DEFAULT_PORT} (0 \uC774\uBA74 OS \uAC00 \uBE48 \uD3EC\uD2B8\uB97C \uACE0\uB978\uB2E4)
  --host <addr>    \uAE30\uBCF8 127.0.0.1 (\uC678\uBD80 \uACF5\uAC1C\uB294 0.0.0.0)
  --ttl <ms>       \uBD09\uD22C \uBCF4\uAD00 \uAE30\uAC04, \uAE30\uBCF8 ${DEFAULT_TTL_MS} (7\uC77C)
  --max-queue <n>  \uC218\uC2E0\uC790\uB2F9 \uD050 \uC0C1\uD55C, \uAE30\uBCF8 ${DEFAULT_MAX_QUEUE}

  ACM_RELAY_STORE  memory(local)\xB7turso\xB7upstash \uC911 \uC800\uC7A5\uC18C\uB97C \uC120\uD0DD\uD55C\uB2E4.
                   \uB85C\uCEEC \uAE30\uBCF8\uAC12\uC740 memory \uB2E4. \uC11C\uBC84\uB9AC\uC2A4\uC5D0\uC11C\uB294 memory \uB97C \uC4F8 \uC218 \uC5C6\uB2E4.

  ACM_RELAY_TOKEN  \uC4F0\uAE30 \uD1A0\uD070 (\uD658\uACBD\uBCC0\uC218, \uCD5C\uC18C ${MIN_TOKEN_CHARS}\uC790 \u2014 \`openssl rand -hex 32\`).
                   \uB8E8\uD504\uBC31 \uBC16\uC73C\uB85C \uC5F4\uB824\uBA74 \uBC18\uB4DC\uC2DC \uC788\uC5B4\uC57C \uD55C\uB2E4 (\xA710.13).
                   \uD50C\uB798\uADF8\uAC00 \uC544\uB2CC \uC774\uC720\uB294 \`ps\` \uC5D0 \uADF8\uB300\uB85C \uCC0D\uD788\uAE30 \uB54C\uBB38\uC774\uB2E4.

  POST /post            \uBD09\uD22C\uB97C \uC62C\uB9B0\uB2E4
  GET  /fetch/<key id>  \uC218\uC2E0\uD568\uC744 \uBE44\uC6B0\uBA70 \uAC00\uC838\uAC04\uB2E4
  GET  /health          \uC0C1\uD0DC \uD655\uC778
`;
function parseArgs(argv, env = {}) {
  const fromEnv3 = { port: parsePort(env.PORT), host: parseHost(env.HOST) };
  let port = fromEnv3.port ?? DEFAULT_PORT;
  let host = fromEnv3.host ?? "127.0.0.1";
  let ttlMs = parsePositive(env.ACM_TTL_MS) ?? DEFAULT_TTL_MS;
  let maxQueue = parsePositive(env.ACM_MAX_QUEUE) ?? DEFAULT_MAX_QUEUE;
  const origin = {
    port: fromEnv3.port === undefined ? "default" : "env",
    host: fromEnv3.host === undefined ? "default" : "env"
  };
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      port = required(argv[++i], "--port", parsePort);
      origin.port = "flag";
    } else if (arg === "--host") {
      host = required(argv[++i], "--host", parseHost);
      origin.host = "flag";
    } else if (arg === "--ttl")
      ttlMs = required(argv[++i], "--ttl", parsePositive);
    else if (arg === "--max-queue")
      maxQueue = required(argv[++i], "--max-queue", parsePositive);
    else
      throw new Error(`\uBAA8\uB974\uB294 \uC778\uC790: ${arg}

${USAGE}`);
  }
  return { port, host, ttlMs, maxQueue, origin };
}
function parsePort(text) {
  if (text === undefined || !/^\d+$/.test(text))
    return;
  const n = Number(text);
  return n <= 65535 ? n : undefined;
}
function parseHost(text) {
  if (text === undefined || text.trim() === "" || text.startsWith("-"))
    return;
  return text;
}
function parsePositive(text) {
  if (text === undefined)
    return;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function bindError(cause, args) {
  const origin = args.origin ?? { host: "default", port: "default" };
  const label = { flag: "\uD50C\uB798\uADF8", env: "\uD658\uACBD\uBCC0\uC218", default: "\uAE30\uBCF8\uAC12" };
  const host = `--host '${args.host}'`.padEnd(23);
  const port = `--port ${args.port}`.padEnd(23);
  return new Error(`\uB9B4\uB808\uC774\uB97C \uB744\uC6B0\uC9C0 \uBABB\uD588\uB2E4: ${cause instanceof Error ? cause.message : String(cause)}
` + `  ${host} (${label[origin.host]})
` + `  ${port} (${label[origin.port]})`, { cause });
}
function required(raw, flag, parse) {
  const value = parse(raw);
  if (value === undefined)
    throw new Error(`${flag} \uAC12\uC774 \uC798\uBABB\uB410\uB2E4: ${raw === undefined ? "\uC5C6\uC74C" : `'${raw}'`}

${USAGE}`);
  return value;
}

// src/server.ts
var serverless = Boolean(process.env.VERCEL);
function boot() {
  const args = parseArgs(serverless ? [] : process.argv.slice(2), process.env);
  const { store, durable, provider } = selectStore(process.env, args);
  const postAuth = selectPostAuth(process.env, { serverless, host: args.host });
  const handler = createHandler({ store, postAuth });
  const options = {
    ...serverless ? {} : { port: args.port, hostname: args.host },
    fetch(req) {
      const path = new URL(req.url).pathname.replace(/\/+$/, "");
      if (durable && path === "/keepalive")
        return keepalive(req, store);
      return handler(req);
    }
  };
  let server;
  try {
    server = Bun.serve(options);
  } catch (e) {
    throw serverless ? e : bindError(e, args);
  }
  if (!serverless) {
    process.stdout.write(`\uB9B4\uB808\uC774\uAC00 \uB5B4\uB2E4: http://${args.host}:${server.port}
` + `  \uC124\uC815\uC758 relay \uC5D0 \uC774 \uC8FC\uC18C\uB97C \uB123\uB294\uB2E4.

` + (provider === "memory" ? `\uC800\uC7A5\uC18C\uB294 \uBA54\uBAA8\uB9AC\uB2E4 \u2014 \uC774 \uD504\uB85C\uC138\uC2A4\uAC00 \uC8FD\uC73C\uBA74 \uB300\uAE30 \uC911\uC778 \uBD09\uD22C\uAC00 \uC0AC\uB77C\uC9C4\uB2E4.
` : `\uC800\uC7A5\uC18C\uB294 ${provider === "turso" ? "Turso" : "Upstash"} \uB2E4 \u2014 \uBC30\uB2EC\uB418\uAC70\uB098 TTL \uC774 \uC9C0\uB098\uBA74 \uD050\uC5D0\uC11C \uC0AC\uB77C\uC9C4\uB2E4.
`) + ("open" in postAuth ? `\uC4F0\uAE30\uB294 \uC778\uC99D\uD558\uC9C0 \uC54A\uB294\uB2E4 \u2014 \uC774 \uAE30\uACC4\uC5D0\uC11C\uB9CC \uB2FF\uC744 \uC218 \uC788\uC5B4\uC11C\uB2E4.
` + `\uC678\uBD80\uC5D0 \uC5F4\uB824\uBA74 ACM_RELAY_TOKEN \uC744 \uB9CC\uB4E4\uACE0 --host 0.0.0.0 \uC744 \uC900\uB2E4.
` : `\uC4F0\uAE30\uC5D0\uB294 ACM_RELAY_TOKEN \uC774 \uD544\uC694\uD558\uB2E4 (\xA710.13).
` + `\u26A0\uFE0F  \uBA54\uD0C0\uB370\uC774\uD130(key id\xB7\uCC44\uB110 \uD0DC\uADF8\xB7\uD06C\uAE30)\uB294 \uB9B4\uB808\uC774\uB97C \uBCF4\uB294 \uCABD\uC5D0 \uB4DC\uB7EC\uB09C\uB2E4.
` + `   docs/architecture.md \xA710.8
`));
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.stop();
      process.exit(0);
    });
  }
  return server;
}
var server;
try {
  server = boot();
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}
`);
  process.exit(1);
}
var server_default = server;
export {
  server_default as default
};
