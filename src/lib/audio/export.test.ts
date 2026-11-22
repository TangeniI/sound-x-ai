import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, generativeEngine } from "../generative-engine";
import { loopBars } from "../groove/flow";
import { encodeConfig, parseConfigFromURL } from "../share";
import { crc32, makeZip } from "../zip";
import { CHANNELS } from "./graph";
import { encodeWav } from "./render";
import { sliceTrack, STEMS, stemsFor, stemTrack } from "./slice";

const groove = (over = {}) => generativeEngine.generate({ ...DEFAULT_CONFIG, style: "driving", bars: 64, ...over });
const isKick = (n: { instrument: string; pitch: number }) => n.instrument === "drums" && (n.pitch === 35 || n.pitch === 36);

describe("loop slices", () => {
  const t = groove();
  const start = loopBars(t.sections).start;

  it("keeps exactly the bars asked for, from step 0", () => {
    const s = sliceTrack(t, start, 8);
    const inside = t.notes.filter((n) => n.step >= start * 16 && n.step < (start + 8) * 16);
    expect(s.notes).toHaveLength(inside.length);
    expect(Math.min(...s.notes.map((n) => n.step))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s.notes.map((n) => n.step))).toBeLessThan(128);
    expect(s.durationSec).toBeCloseTo(8 * 16 * t.stepSec, 9);
    expect(s.notes.find((n) => n.step === 0 && n.pitch === 36)!.startTime).toBeCloseTo(0, 9);
  });

  it("plays the same notes in every pass", () => {
    const s = sliceTrack(t, start, 4, 2);
    const pass = (p: number) => s.notes.filter((n) => Math.floor(n.step / 64) === p).map((n) => `${n.step % 64}:${n.pitch}:${n.instrument}`).sort();
    expect(pass(1)).toEqual(pass(0));
  });

  it("starts each pass from the mix as it stood on the first bar", () => {
    const s = sliceTrack(t, start, 8, 2);
    const len = 8 * 16 * t.stepSec;
    for (const param of new Set(t.automation.map((a) => a.param))) {
      const at = (time: number) => s.automation.filter((a) => a.param === param && Math.abs(a.time - time) < 1e-9);
      expect(at(0)).toHaveLength(1);
      expect(at(len)[0]).toEqual({ ...at(0)[0], time: len });
    }
  });

  it("uses the end sounds for a loop after the first drop, and the first ones before it", () => {
    const after = sliceTrack(t, start, 8);
    expect(after.kit).toEqual(t.endKit!.kit);
    expect(after.endKit).toBeUndefined();
    const before = sliceTrack(t, 0, 8);
    expect(before.kit).toEqual(t.kit);
    expect(before.endKit).toBeUndefined();
    const across = sliceTrack(t, start - 4, 8, 2);
    expect(across.endKit!.from).toBe(128 + 64);
  });
});

describe("stems", () => {
  const t = groove();

  it("puts every note in exactly one stem", () => {
    for (const n of t.notes) expect(STEMS.filter((s) => s.notes(n))).toHaveLength(1);
  });

  it("gives the kick a stem of its own, and keeps silent kicks elsewhere for the pump", () => {
    const kick = stemTrack(t, STEMS.find((s) => s.name === "kick")!);
    expect(kick.notes.every(isKick)).toBe(true);
    const clap = stemTrack(t, STEMS.find((s) => s.name === "clap-snare")!);
    expect(clap.notes.filter(isKick).every((n) => n.velocity === 0)).toBe(true);
    expect(clap.notes.filter(isKick)).toHaveLength(t.notes.filter(isKick).length);
    // where the kick's channel doesn't play, the kicks stay as they were, to drive the rumble
    const low = stemTrack(t, STEMS.find((s) => s.name === "low-end")!);
    expect(low.notes.filter(isKick).every((n) => n.velocity > 0)).toBe(true);
  });

  it("leaves out stems that mute or solo silence", () => {
    const all = stemsFor(t, new Set(CHANNELS)).map((s) => s.name);
    expect(all).toContain("kick");
    expect(stemsFor(t, new Set(CHANNELS.filter((c) => c !== "drums"))).map((s) => s.name)).not.toContain("kick");
  });
});

describe("files", () => {
  it("writes 24-bit WAV, sample for sample", () => {
    const data = [new Float32Array([0, 0.5, -1, 1]), new Float32Array([0.25, -0.25, 0, 0])];
    const buffer = { numberOfChannels: 2, sampleRate: 44100, length: 4, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
    return encodeWav(buffer, 24).arrayBuffer().then((ab) => {
      const v = new DataView(ab);
      expect(v.getUint16(34, true)).toBe(24);
      expect(v.getUint32(24, true)).toBe(44100);
      expect(v.getUint32(40, true)).toBe(4 * 2 * 3);
      const at = (i: number) => { const o = 44 + i * 3; const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16); return x; };
      expect([at(0), at(2), at(4), at(6)]).toEqual([0, Math.round(0.5 * 0x7fffff), -0x7fffff, 0x7fffff]);
    });
  });

  it("zips files that come back out intact", async () => {
    const a = new TextEncoder().encode("kick");
    const b = new Uint8Array(1000).map((_, i) => i % 251);
    const bytes = new Uint8Array(await makeZip([{ name: "x/a.wav", data: a }, { name: "x/b.wav", data: b }]).arrayBuffer());
    const v = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    let dir = v.getUint32(end + 16, true);
    for (const want of [a, b]) {
      const offset = v.getUint32(dir + 42, true);
      const nameLen = v.getUint16(offset + 26, true);
      const size = v.getUint32(offset + 18, true);
      const body = bytes.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size);
      expect(body).toEqual(want);
      expect(v.getUint32(offset + 14, true)).toBe(crc32(want));
      dir += 46 + v.getUint16(dir + 28, true);
    }
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("levels", () => {
  it("travel in a share link and come back clamped", () => {
    const cfg = { ...DEFAULT_CONFIG, levels: { drums: -3, bass: 2.5, rumble: -6, fx: 40 } };
    const back = parseConfigFromURL(encodeConfig(cfg)).config;
    expect(back.levels).toEqual({ drums: -3, bass: 2.5, rumble: -6, fx: 6 });
    expect(encodeConfig({ ...DEFAULT_CONFIG, levels: { drums: 0 } })).not.toContain("g=");
  });
});
