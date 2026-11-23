/**
 * lib/audio/tags.ts
 *
 * What a DJ's library needs to know about a file: its tempo, key and Camelot
 * number. Written as an ID3 tag, which Rekordbox, Traktor and Serato read from
 * WAV and AIFF, and as RIFF INFO for players that only read that. Also the AIFF
 * container itself, which DJ software tags more reliably than WAV.
 */

import { NOTE_NAMES } from "../labels";

export interface Tags {
  title:   string;
  bpm:     number;
  key:     string;  // as DJ software writes it: Am, F#m, C
  camelot: string;  // 8A
  genre?:  string;  // a store's shelf: Techno (Peak Time / Driving)
}

// minor keys from C: C is 5A, the wheel moves a fifth per step
const MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];

/** Phrygian and Dorian count as minor, as key-detection software reads them. */
export function camelot(root: number, tonality: "minor" | "major"): string {
  return (tonality === "major" ? MAJOR : MINOR)[((root % 12) + 12) % 12];
}

export function keyName(root: number, tonality: "minor" | "major"): string {
  return `${NOTE_NAMES[((root % 12) + 12) % 12]}${tonality === "minor" ? "m" : ""}`;
}

const latin1 = (s: string) => Uint8Array.from([...s].map((c) => { const x = c.charCodeAt(0); return x < 256 ? x : 63; }));

/** An ID3v2.3 tag: title, tempo, key, genre, and the Camelot number as a comment. */
export function id3(tags: Tags): Uint8Array {
  const frame = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(10 + body.length);
    out.set(latin1(id), 0);
    new DataView(out.buffer).setUint32(4, body.length);
    out.set(body, 10);
    return out;
  };
  const text = (id: string, value: string) => frame(id, Uint8Array.from([0, ...latin1(value)]));
  const frames = [
    text("TIT2", tags.title),
    text("TBPM", String(Math.round(tags.bpm))),
    text("TKEY", tags.key),
    text("TCON", tags.genre ?? "Techno"),
    frame("COMM", Uint8Array.from([0, ...latin1("eng"), 0, ...latin1(`${tags.camelot} - ${tags.key} - ${Math.round(tags.bpm)} BPM`)])),
  ];
  const size = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + size);
  out.set(latin1("ID3"), 0);
  out[3] = 3; // v2.3
  // the tag size is "syncsafe": seven bits to a byte
  for (let i = 0; i < 4; i++) out[6 + i] = (size >> (7 * (3 - i))) & 0x7f;
  let at = 10;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
}

/** A RIFF LIST/INFO chunk body: title, genre and a comment with the key and tempo. */
export function riffInfo(tags: Tags): Uint8Array {
  const item = (id: string, value: string) => {
    const text = latin1(value + "\0");
    const padded = text.length + (text.length % 2);
    const out = new Uint8Array(8 + padded);
    out.set(latin1(id), 0);
    new DataView(out.buffer).setUint32(4, text.length, true);
    out.set(text, 8);
    return out;
  };
  const items = [
    item("INAM", tags.title),
    item("IGNR", tags.genre ?? "Techno"),
    item("ICMT", `${tags.camelot} - ${tags.key} - ${Math.round(tags.bpm)} BPM`),
  ];
  const size = 4 + items.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(size);
  out.set(latin1("INFO"), 0);
  let at = 4;
  for (const x of items) { out.set(x, at); at += x.length; }
  return out;
}

/** Interleaved PCM: 24-bit, or 16-bit with triangular dither. */
export function pcm(buffer: AudioBuffer, bits: 16 | 24, little: boolean): Uint8Array {
  const channels = buffer.numberOfChannels;
  const bytes = bits / 8;
  const out = new Uint8Array(buffer.length * channels * bytes);
  const view = new DataView(out.buffer);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let at = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const x = data[c][i];
      if (bits === 24) {
        // far below anything audible, so 24-bit needs no dither
        const v = Math.max(-0x800000, Math.min(0x7fffff, Math.round(x * 0x7fffff)));
        const [lo, mid, hi] = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
        out[at] = little ? lo : hi;
        out[at + 1] = mid;
        out[at + 2] = little ? hi : lo;
      } else {
        // one LSB of noise turns rounding distortion on fades into steady hiss
        const dither = x === 0 ? 0 : Math.random() - Math.random();
        view.setInt16(at, Math.max(-0x8000, Math.min(0x7fff, Math.round(x * 0x7fff + dither))), little);
      }
      at += bytes;
    }
  }
  return out;
}

/** A chunk: id, size, body and the pad byte that keeps chunks on even offsets. */
export function chunk(id: string, body: Uint8Array, little: boolean): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length % 2));
  out.set(latin1(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, little);
  out.set(body, 8);
  return out;
}

/** The sample rate as AIFF stores it: an 80-bit extended float. */
function extended(rate: number): Uint8Array {
  const out = new Uint8Array(10);
  const exp = Math.floor(Math.log2(rate));
  const view = new DataView(out.buffer);
  view.setUint16(0, 16383 + exp);
  const mantissa = BigInt(rate) << BigInt(63 - exp);
  view.setBigUint64(2, mantissa);
  return out;
}

export function encodeAiff(buffer: AudioBuffer, bits: 16 | 24 = 24, tags?: Tags): Blob {
  const comm = new Uint8Array(18);
  const v = new DataView(comm.buffer);
  v.setUint16(0, buffer.numberOfChannels);
  v.setUint32(2, buffer.length);
  v.setUint16(6, bits);
  comm.set(extended(buffer.sampleRate), 8);
  const audio = pcm(buffer, bits, false);
  const ssnd = new Uint8Array(8 + audio.length); // offset and block size, both 0
  ssnd.set(audio, 8);
  const parts = [chunk("COMM", comm, false), chunk("SSND", ssnd, false), ...(tags ? [chunk("ID3 ", id3(tags), false)] : [])];
  const size = 4 + parts.reduce((n, p) => n + p.length, 0);
  const head = new Uint8Array(12);
  head.set(latin1("FORM"), 0);
  new DataView(head.buffer).setUint32(4, size);
  head.set(latin1("AIFF"), 8);
  return new Blob([head, ...parts] as BlobPart[], { type: "audio/aiff" });
}
