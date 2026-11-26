import { describe, expect, it } from "vitest";
import { crc16, crc8, encodeFlac, flacFromSamples } from "./flac";
import { quantize } from "./tags";

/** A small FLAC decoder for the subframes the encoder writes. Checks every CRC. */
function decode(bytes: Uint8Array) {
  let pos = 0;
  let bit = 0;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((bytes[pos] >> (7 - bit)) & 1);
      if (++bit === 8) { bit = 0; pos++; }
    }
    return v;
  };
  const signed = (n: number) => { const v = read(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; };
  const unary = () => { let q = 0; while (!read(1)) q++; return q; };

  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("fLaC");
  pos = 4;
  let info = { rate: 0, channels: 0, bps: 0, total: 0 };
  const tags: Record<string, string> = {};
  for (let last = 0; !last;) {
    last = read(1);
    const type = read(7);
    const len = read(24);
    const body = bytes.subarray(pos, pos + len);
    if (type === 0) {
      read(16 + 16 + 24 + 24);
      info = { rate: read(20), channels: read(3) + 1, bps: read(5) + 1, total: read(36) };
      read(128);
    } else {
      if (type === 4) {
        const view = new DataView(body.buffer, body.byteOffset);
        let at = 4 + view.getUint32(0, true);
        const count = view.getUint32(at, true);
        at += 4;
        for (let i = 0; i < count; i++) {
          const n = view.getUint32(at, true);
          const [k, ...v] = new TextDecoder().decode(body.subarray(at + 4, at + 4 + n)).split("=");
          tags[k] = v.join("=");
          at += 4 + n;
        }
      }
      pos += len;
    }
  }

  const out = Array.from({ length: info.channels }, () => new Int32Array(info.total));
  let done = 0;
  let frames = 0;
  while (done < info.total) {
    const start = pos;
    expect(read(15)).toBe(0x7ffc);
    read(1);
    const sizeCode = read(4);
    read(4);
    const assignment = read(4);
    read(3 + 1);
    // frame number, UTF-8 shaped
    const first = read(8);
    for (let extra = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3; extra > 0; extra--) read(8);
    const n = sizeCode === 12 ? 4096 : sizeCode === 6 ? read(8) + 1 : read(16) + 1;
    expect(read(8)).toBe(crc8(bytes.subarray(start, pos - 1)));
    const subs: Int32Array[] = [];
    for (let c = 0; c < info.channels; c++) {
      const bps = info.bps + ((assignment === 8 && c === 1) || (assignment === 9 && c === 0) || (assignment === 10 && c === 1) ? 1 : 0);
      expect(read(1)).toBe(0);
      const type = read(6);
      expect(read(1)).toBe(0);
      const x = new Int32Array(n);
      if (type === 0) x.fill(signed(bps));
      else if (type === 1) for (let i = 0; i < n; i++) x[i] = signed(bps);
      else {
        expect(type & 0x38).toBe(8);
        const order = type & 7;
        for (let i = 0; i < order; i++) x[i] = signed(bps);
        const wide = read(2);
        const partitions = 2 ** read(4);
        let i = order;
        for (let p = 0; p < partitions; p++) {
          const k = read(wide ? 5 : 4);
          const end = (p + 1) * (n / partitions);
          for (; i < end; i++) {
            const u = unary() * 2 ** k + read(k);
            const r = u % 2 ? -(u + 1) / 2 : u / 2;
            const pred = [0, x[i - 1], 2 * x[i - 1] - x[i - 2], 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3], 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]][order];
            x[i] = pred + r;
          }
        }
      }
      subs.push(x);
    }
    if (bit) { bit = 0; pos++; }
    const crc = read(16);
    expect(crc).toBe(crc16(bytes.subarray(start, pos - 2)));
    for (let i = 0; i < n; i++) {
      let [a, b] = [subs[0][i], subs[1]?.[i]];
      if (assignment === 8) b = a - b;
      else if (assignment === 9) a = a + b;
      else if (assignment === 10) { const m = a * 2 + (b & 1); a = (m + b) >> 1; b = (m - b) >> 1; }
      out[0][done + i] = a;
      if (info.channels > 1) out[1][done + i] = b;
    }
    done += n;
    frames++;
  }
  expect(pos).toBe(bytes.length);
  return { ...info, out, tags, frames };
}

/** A deterministic noise source, so a failing case can be run again. */
function noise(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
}

const signal = (length: number, bits: 16 | 24, make: (i: number, c: number) => number) =>
  [0, 1].map((c) => Int32Array.from({ length }, (_, i) => quantize(make(i, c), bits)));

describe("FLAC", () => {
  const rnd = noise(7);
  const cases: [string, number, 16 | 24, (i: number, c: number) => number][] = [
    ["a quiet stereo sine", 10_000, 24, (i, c) => 0.3 * Math.sin(i * 0.031 + c)],
    ["full-scale noise", 9_000, 24, () => rnd()],
    ["clipping square", 8_192, 24, (i) => (i % 200 < 100 ? 1 : -1)],
    ["the same in both ears", 5_000, 16, (i) => 0.5 * Math.sin(i * 0.01)],
    ["silence then a click", 12_345, 24, (i, c) => (i === 6_000 && c === 0 ? 0.9 : 0)],
    ["three samples", 3, 24, (i) => i / 4],
    ["one hard-left block", 4_096, 16, (i, c) => (c ? 0 : rnd())],
  ];
  for (const [label, length, bits, make] of cases) {
    it(`gives back ${label} exactly (${bits}-bit)`, () => {
      const input = signal(length, bits, make);
      const flac = decode(flacFromSamples(input, 48000, bits));
      expect([flac.rate, flac.channels, flac.bps, flac.total]).toEqual([48000, 2, bits, length]);
      expect(flac.frames).toBe(Math.ceil(length / 4096));
      expect(Array.from(flac.out[0])).toEqual(Array.from(input[0]));
      expect(Array.from(flac.out[1])).toEqual(Array.from(input[1]));
    });
  }

  it("stores silence and tonal parts far smaller than WAV", () => {
    const length = 48000 * 4;
    const wav = (bits: number) => (length * 2 * bits) / 8;
    expect(flacFromSamples(signal(length, 24, () => 0), 48000, 24).length).toBeLessThan(wav(24) / 500);
    const tone = flacFromSamples(signal(length, 24, (i, c) => 0.25 * Math.sin(i * 0.02 + c * 0.1) * Math.exp(-(i % 12000) / 3000)), 48000, 24);
    expect(tone.length).toBeLessThan(wav(24) * 0.6);
  });

  it("encodes a rendered buffer as the WAV of the same depth quantizes it, with tags", async () => {
    const data = [Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 30) * 0.7), Float32Array.from({ length: 5000 }, (_, i) => Math.cos(i / 41) * 0.7)];
    const buffer = { numberOfChannels: 2, length: 5000, sampleRate: 44100, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
    const blob = encodeFlac(buffer, 24, { title: "take-1", bpm: 138, key: "Am", camelot: "8A", genre: "Techno (Peak Time / Driving)" });
    expect(blob.type).toBe("audio/flac");
    const flac = decode(new Uint8Array(await blob.arrayBuffer()));
    expect(flac.rate).toBe(44100);
    expect(Array.from(flac.out[1].subarray(0, 50))).toEqual(Array.from(data[1].subarray(0, 50), (x) => quantize(x, 24)));
    expect(flac.tags).toMatchObject({ TITLE: "take-1", BPM: "138", INITIALKEY: "Am", GENRE: "Techno (Peak Time / Driving)", COMMENT: "8A - Am - 138 BPM" });
  });
});
