import { describe, expect, it } from "vitest";
import { camelot, encodeAiff, id3, keyName } from "../audio/tags";
import { encodeWav } from "../audio/render";
import { storeGenre } from "../labels";
import { DEFAULT_CONFIG, generativeEngine } from "../generative-engine";
import { FAMILY_IDS } from "./families";
import { DJ_BARS } from "./dj";

const SPB = 16;
const KICK_HAT = new Set([35, 36, 42]);

describe("DJ version", () => {
  for (const family of FAMILY_IDS) {
    it(`${family}: 32 bars of drums alone at each end, six to eight minutes long`, () => {
      const t = generativeEngine.generate({ ...DEFAULT_CONFIG, family, dj: true });
      const bars = t.sections.reduce((n, s) => Math.max(n, s.startBar + s.bars), 0);
      expect(bars).toBe(240);
      expect(t.durationSec / 60).toBeGreaterThanOrEqual(6);
      expect(t.durationSec / 60).toBeLessThanOrEqual(8);
      // phrases run in eights: a short break and build share one, and every drop lands on one
      for (const s of t.sections) expect(s.startBar % 4).toBe(0);
      for (const s of t.sections.filter((x) => x.kind === "drop" || x.kind === "break")) expect(s.startBar % 8).toBe(0);

      const at = (from: number, to: number) => t.notes.filter((n) => n.step >= from * SPB && n.step < to * SPB);
      for (const [from, to] of [[0, DJ_BARS], [bars - DJ_BARS, bars]]) {
        const ends = at(from, to);
        expect(ends.length).toBeGreaterThan(0);
        expect(ends.every((n) => n.instrument === "drums")).toBe(true);
      }
      // kick and hats first, the whole kit after; the outro mirrors it
      expect(at(0, 16).every((n) => KICK_HAT.has(n.pitch))).toBe(true);
      expect(at(bars - 16, bars).every((n) => KICK_HAT.has(n.pitch))).toBe(true);
      expect(at(0, 16).filter((n) => n.pitch === 36).length).toBeGreaterThanOrEqual(16 * 3);
    });
  }

  it("is the same track inside, moved 32 bars on, with the rumble shut at the ends", () => {
    const plain = generativeEngine.generate({ ...DEFAULT_CONFIG, bars: 176 });
    const t = generativeEngine.generate({ ...DEFAULT_CONFIG, dj: true });
    const off = DJ_BARS * SPB;
    const inside = t.notes.filter((n) => n.step >= off && n.step < off + 176 * SPB).map((n) => `${n.step - off}:${n.pitch}:${n.instrument}`).sort();
    expect(inside).toEqual(plain.notes.map((n) => `${n.step}:${n.pitch}:${n.instrument}`).sort());
    const low = t.automation.filter((a) => a.param === "low");
    const barSec = t.stepSec * SPB;
    expect(low[0]).toMatchObject({ time: 0, value: 0 });
    expect(low.some((a) => Math.abs(a.time - DJ_BARS * barSec) < 1e-9 && a.value === 1)).toBe(true);
    expect(low[low.length - 1].value).toBe(0);
    expect(t.endKit!.from).toBe(plain.endKit!.from + off);
  });

  it("takes edits where they're made in the finished track", () => {
    const edit = { op: "add" as const, lane: "perc" as const, step: 3 * SPB + 5, pitch: 56 };
    const t = generativeEngine.generate({ ...DEFAULT_CONFIG, dj: true }, [edit]);
    const n = t.notes.find((x) => x.instrument === "perc" && x.step === edit.step)!;
    expect(n.startTime).toBeGreaterThan(3 * 16 * t.stepSec);
    expect(n.startTime).toBeLessThan(4 * 16 * t.stepSec);
  });
});

describe("DJ tags", () => {
  it("name keys the way DJ software does", () => {
    expect([camelot(9, "minor"), keyName(9, "minor")]).toEqual(["8A", "Am"]);
    expect([camelot(0, "major"), keyName(0, "major")]).toEqual(["8B", "C"]);
    expect([camelot(6, "minor"), camelot(5, "minor"), camelot(4, "minor")]).toEqual(["11A", "4A", "9A"]);
  });

  it("write an ID3 tag with the tempo and key", () => {
    const tag = id3({ title: "x", bpm: 137.6, key: "F#m", camelot: "11A" });
    const text = new TextDecoder("latin1").decode(tag);
    expect(text.startsWith("ID3\u0003")).toBe(true);
    expect(text).toContain("TBPM");
    expect(text).toContain("138");
    expect(text).toContain("F#m");
    expect(text).toContain("11A - F#m - 138 BPM");
    const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9];
    expect(size).toBe(tag.length - 10);
  });

  it("file each style on a store's shelf", () => {
    expect(storeGenre("driving")).toBe("Techno (Peak Time / Driving)");
    expect(storeGenre("hypnotic")).toBe("Techno (Raw / Deep / Hypnotic)");
    const text = new TextDecoder("latin1").decode(id3({ title: "x", bpm: 138, key: "Am", camelot: "8A", genre: storeGenre("warehouse") }));
    expect(text).toContain("Techno (Raw / Deep / Hypnotic)");
  });

  const buffer = { numberOfChannels: 2, sampleRate: 44100, length: 3, getChannelData: () => new Float32Array([0, 0.5, -0.5]) } as unknown as AudioBuffer;
  const tags = { title: "t", bpm: 138, key: "Am", camelot: "8A" };

  it("keep WAV chunks in order and sized right", async () => {
    const bytes = new Uint8Array(await encodeWav(buffer, 24, tags).arrayBuffer());
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    const ids: string[] = [];
    for (let at = 12; at < bytes.length; at += 8 + v.getUint32(at + 4, true) + (v.getUint32(at + 4, true) % 2)) {
      ids.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
    }
    expect(ids).toEqual(["fmt ", "data", "LIST", "id3 "]);
  });

  it("write AIFF big-endian, with the rate as an 80-bit float", async () => {
    const bytes = new Uint8Array(await encodeAiff(buffer, 24, tags).arrayBuffer());
    const v = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4), ...bytes.subarray(8, 12))).toBe("FORMAIFF");
    expect(v.getUint32(4)).toBe(bytes.length - 8);
    expect([...bytes.subarray(28, 38)]).toEqual([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    // second frame, left: 0.5 as 24-bit big-endian, after the SSND header
    const first = 12 + 26 + 16;
    expect([...bytes.subarray(first + 6, first + 9)]).toEqual([0x40, 0x00, 0x00]); // round(0.5 × 0x7fffff)
  });
});
