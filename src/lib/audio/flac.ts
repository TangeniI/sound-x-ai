/**
 * lib/audio/flac.ts
 *
 * FLAC: lossless, and much smaller than WAV. Each block of 4,096 samples is
 * predicted from the samples before it (a fixed polynomial of order 0 to 4, the
 * one that predicts best), and only the prediction error is stored, in Rice
 * codes sized to each stretch of the block. A silent block is one number, so a
 * sparse stem shrinks to almost nothing. Stereo is stored as whichever pair is
 * smallest: left and right, left and side, side and right, or mid and side.
 *
 * Decoding gives back exactly the samples a WAV of the same bit depth holds.
 * The MD5 of the audio is left unset, which the format allows.
 */

import { quantize, type Tags } from "./tags";

const BLOCK = 4096;
const MAX_PARTITION_ORDER = 8;

/** Writes bits, most significant first, into a buffer that grows. */
class BitWriter {
  buf: Uint8Array;
  pos = 0;
  private acc = 0;
  private n = 0;
  constructor(size: number) { this.buf = new Uint8Array(Math.max(64, size)); }

  room(bytes: number) {
    if (this.pos + bytes + 8 <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + bytes + 8));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** The low `bits` bits of `value`, up to 24 at a time. */
  put(value: number, bits: number) {
    this.acc = (this.acc << bits) | (value & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) {
      this.n -= 8;
      this.buf[this.pos++] = (this.acc >>> this.n) & 0xff;
    }
    this.acc &= (1 << this.n) - 1;
  }

  /** A two's complement value in up to 32 bits. */
  signed(value: number, bits: number) {
    if (bits > 24) {
      this.put(value >> 24, bits - 24);
      this.put(value & 0xffffff, 24);
    } else this.put(value, bits);
  }

  zeros(count: number) {
    while (count > 24) { this.put(0, 24); count -= 24; }
    this.put(0, count);
  }

  /** One Rice code: the quotient in unary (zeros, then a one), then `k` low bits. */
  rice(u: number, k: number) {
    const q = u >>> k;
    const low = u & ((1 << k) - 1);
    if (q + 1 + k <= 24) return this.put((1 << k) | low, q + 1 + k);
    this.zeros(q);
    this.put(1, 1);
    if (k > 24) { this.put(low >>> 24, k - 24); this.put(low & 0xffffff, 24); } else this.put(low, k);
  }

  align() { if (this.n) this.put(0, 8 - this.n); }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}
export const crc8 = (d: Uint8Array) => d.reduce((c, b) => CRC8[c ^ b], 0);
export const crc16 = (d: Uint8Array) => d.reduce((c, b) => ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b], 0);

const RATE_CODE: Record<number, number> = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };
const BITS_CODE: Record<number, number> = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

/** How one channel of a block will be stored, and about how many bits that takes. */
interface Plan {
  kind: "constant" | "verbatim" | "fixed";
  bits: number;
  order: number;
  partitionOrder: number;
  params: number[];
  wide: boolean;
}

interface Subframe { x: Int32Array; bps: number; plan: Plan }

// scratch space for a block's prediction errors, one array per order
const residuals = Array.from({ length: 5 }, () => new Int32Array(BLOCK));

/** Unsigned form of a signed error, so small errors of either sign get short codes. */
const zigzag = (r: number) => ((r << 1) ^ (r >> 31)) >>> 0;

function fixedResidual(x: Int32Array, n: number, order: number, out: Int32Array) {
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: out[i] = x[i]; break;
      case 1: out[i] = x[i] - x[i - 1]; break;
      case 2: out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
}

/** Best Rice parameter for a stretch of `count` errors summing to `sum`, and its bits (a bound). */
function riceCost(sum: number, count: number): [number, number] {
  if (count === 0) return [0, 0];
  const mean = sum / count;
  const guess = mean < 1 ? 0 : Math.min(30, Math.floor(Math.log2(mean)));
  let best: [number, number] = [0, Infinity];
  for (let k = Math.max(0, guess - 1); k <= Math.min(30, guess + 1); k++) {
    const bits = count * (k + 1) + Math.floor(sum / 2 ** k);
    if (bits < best[1]) best = [k, bits];
  }
  return best;
}

function plan(x: Int32Array, n: number, bps: number): Plan {
  const verbatim: Plan = { kind: "verbatim", bits: 8 + n * bps, order: 0, partitionOrder: 0, params: [], wide: false };
  let same = true;
  for (let i = 1; i < n && same; i++) same = x[i] === x[0];
  if (same) return { ...verbatim, kind: "constant", bits: 8 + bps };
  if (n <= 4) return verbatim;

  // the order whose errors are smallest over the samples every order predicts
  let order = 0;
  let least = Infinity;
  for (let o = 0; o <= 4; o++) {
    fixedResidual(x, n, o, residuals[o]);
    let sum = 0;
    for (let i = 4; i < n; i++) sum += Math.abs(residuals[o][i]);
    if (sum < least) { least = sum; order = o; }
  }
  const r = residuals[order];

  // the finest split of the block into equal partitions, then coarser ones from it
  let top = 0;
  while (top < MAX_PARTITION_ORDER && n % (1 << (top + 1)) === 0 && n >> (top + 1) > order) top++;
  let sums: number[] = [];
  let counts: number[] = [];
  const size = n >> top;
  for (let j = 0; j < 1 << top; j++) {
    let sum = 0;
    for (let i = Math.max(order, j * size); i < (j + 1) * size; i++) sum += zigzag(r[i]);
    sums.push(sum);
    counts.push((j + 1) * size - Math.max(order, j * size));
  }
  let best: Plan = verbatim;
  for (let p = top; p >= 0; p--) {
    const params: number[] = [];
    let bits = 8 + order * bps + 6;
    for (let j = 0; j < sums.length; j++) {
      const [k, cost] = riceCost(sums[j], counts[j]);
      params.push(k);
      bits += 4 + cost;
    }
    const wide = params.some((k) => k > 14);
    if (wide) bits += params.length;
    if (bits < best.bits) best = { kind: "fixed", bits, order, partitionOrder: p, params, wide };
    sums = sums.flatMap((s, j) => (j % 2 ? [] : [s + sums[j + 1]]));
    counts = counts.flatMap((c, j) => (j % 2 ? [] : [c + counts[j + 1]]));
  }
  return best;
}

function writeSubframe(w: BitWriter, x: Int32Array, n: number, bps: number, p: Plan) {
  w.put(0, 1);
  if (p.kind === "constant") {
    w.put(0, 7);
    w.signed(x[0], bps);
    return;
  }
  if (p.kind === "verbatim") {
    w.put(1 << 1, 7);
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  w.put((8 | p.order) << 1, 7);
  for (let i = 0; i < p.order; i++) w.signed(x[i], bps);
  fixedResidual(x, n, p.order, residuals[0]);
  const r = residuals[0];
  w.put(p.wide ? 1 : 0, 2);
  w.put(p.partitionOrder, 4);
  const size = n >> p.partitionOrder;
  for (let j = 0; j < p.params.length; j++) {
    const k = p.params[j];
    w.put(k, p.wide ? 5 : 4);
    for (let i = Math.max(p.order, j * size); i < (j + 1) * size; i++) w.rice(zigzag(r[i]), k);
  }
}

/** A frame number as FLAC writes it, in the shape of UTF-8. */
function frameNumber(w: BitWriter, v: number) {
  if (v < 0x80) return w.put(v, 8);
  const bytes = v < 0x800 ? 2 : v < 0x10000 ? 3 : 4;
  w.put(((0xff00 >> bytes) & 0xff) | (v >> (6 * (bytes - 1))), 8);
  for (let b = bytes - 2; b >= 0; b--) w.put(0x80 | ((v >> (6 * b)) & 0x3f), 8);
}

/** A metadata block: its type and length, then its body. */
function metadata(type: number, body: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  out[0] = (last ? 0x80 : 0) | type;
  out[1] = body.length >> 16;
  out[2] = (body.length >> 8) & 0xff;
  out[3] = body.length & 0xff;
  out.set(body, 4);
  return out;
}

/** Vorbis comments: the title, tempo, key and genre, as DJ software reads them from FLAC. */
function comments(tags: Tags): Uint8Array {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const fields = [
    `TITLE=${tags.title}`,
    `BPM=${Math.round(tags.bpm)}`,
    `INITIALKEY=${tags.key}`,
    `GENRE=${tags.genre ?? "Techno"}`,
    `COMMENT=${tags.camelot} - ${tags.key} - ${Math.round(tags.bpm)} BPM`,
  ].map(utf8);
  const vendor = utf8("Sound x AI");
  const out = new Uint8Array(8 + vendor.length + fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, vendor.length, true);
  out.set(vendor, 4);
  let at = 4 + vendor.length;
  view.setUint32(at, fields.length, true);
  at += 4;
  for (const f of fields) {
    view.setUint32(at, f.length, true);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

/** FLAC from integer samples, one array per channel, all the same length. */
export function flacFromSamples(channels: Int32Array[], sampleRate: number, bps: 16 | 24, tags?: Tags): Uint8Array {
  const length = channels[0].length;
  const stereo = channels.length === 2;
  const w = new BitWriter((length * channels.length * bps) / 16);
  const mid = new Int32Array(BLOCK);
  const side = new Int32Array(BLOCK);
  let minFrame = Infinity;
  let maxFrame = 0;

  for (let start = 0, frame = 0; start < length; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, length - start);
    const block = channels.map((c) => c.subarray(start, start + n));

    // which pair of signals to store, and how
    let assignment = channels.length - 1;
    let subframes: Subframe[];
    const plans: Subframe[] = block.map((x) => ({ x, bps, plan: plan(x, n, bps) }));
    if (stereo) {
      const [l, r] = block;
      for (let i = 0; i < n; i++) { mid[i] = (l[i] + r[i]) >> 1; side[i] = l[i] - r[i]; }
      const m: Subframe = { x: mid.subarray(0, n), bps, plan: plan(mid, n, bps) };
      const s: Subframe = { x: side.subarray(0, n), bps: bps + 1, plan: plan(side, n, bps + 1) };
      const options: [number, Subframe[]][] = [[1, plans], [8, [plans[0], s]], [9, [s, plans[1]]], [10, [m, s]]];
      [assignment, subframes] = options.reduce((a, b) => (b[1][0].plan.bits + b[1][1].plan.bits < a[1][0].plan.bits + a[1][1].plan.bits ? b : a));
    } else subframes = plans;
    // planning overwrote the scratch errors; each subframe works its own out again as it's written

    w.room(16 + subframes.reduce((b, f) => b + Math.ceil(f.plan.bits / 8) + 8, 0));
    const at = w.pos;
    w.put(0x3ffe, 14);
    w.put(0, 2); // reserved, fixed block size
    const sizeCode = n === BLOCK ? 12 : n <= 256 ? 6 : 7;
    w.put(sizeCode, 4);
    w.put(RATE_CODE[sampleRate] ?? 0, 4);
    w.put(assignment, 4);
    w.put(BITS_CODE[bps], 3);
    w.put(0, 1);
    frameNumber(w, frame);
    if (sizeCode === 6) w.put(n - 1, 8);
    if (sizeCode === 7) w.put(n - 1, 16);
    w.put(crc8(w.buf.subarray(at, w.pos)), 8);
    for (const f of subframes) writeSubframe(w, f.x, n, f.bps, f.plan);
    w.align();
    w.put(crc16(w.buf.subarray(at, w.pos)), 16);
    minFrame = Math.min(minFrame, w.pos - at);
    maxFrame = Math.max(maxFrame, w.pos - at);
  }

  const info = new BitWriter(34);
  info.put(BLOCK, 16);
  info.put(BLOCK, 16);
  info.put(length ? minFrame : 0, 24);
  info.put(maxFrame, 24);
  info.put(sampleRate, 20);
  info.put(channels.length - 1, 3);
  info.put(bps - 1, 5);
  info.put(Math.floor(length / 2 ** 24), 12);
  info.put(length % 2 ** 24, 24);
  info.zeros(128); // MD5 unset
  const blocks = [metadata(0, info.buf.subarray(0, 34), !tags), ...(tags ? [metadata(4, comments(tags), true)] : [])];

  const head = blocks.reduce((n, b) => n + b.length, 4);
  const out = new Uint8Array(head + w.pos);
  out.set([0x66, 0x4c, 0x61, 0x43], 0); // fLaC
  let at = 4;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  out.set(w.buf.subarray(0, w.pos), at);
  return out;
}

/** A rendered buffer as FLAC, sampled as the WAV of the same depth would be. */
export function encodeFlac(buffer: AudioBuffer, bits: 16 | 24 = 24, tags?: Tags): Blob {
  const channels: Int32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const out = new Int32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = quantize(data[i], bits);
    channels.push(out);
  }
  return new Blob([flacFromSamples(channels, buffer.sampleRate, bits, tags) as Uint8Array<ArrayBuffer>], { type: "audio/flac" });
}
