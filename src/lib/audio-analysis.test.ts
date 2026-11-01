import { describe, it, expect } from "vitest";
import { computeChroma, estimateKey, estimateTempo } from "./audio-analysis";

const SR = 44100;

/** A plain kick pulse: nothing to lock onto but the tempo itself. */
function pulse(bpm: number, seconds = 30): Float32Array {
  const x = new Float32Array(SR * seconds);
  const period = (60 / bpm) * SR;
  for (let b = 0; b * period < x.length; b++) {
    const s = Math.round(b * period);
    for (let i = 0; i < 3000 && s + i < x.length; i++) x[s + i] += Math.exp(-i / 600) * Math.sin((2 * Math.PI * 60 * i) / SR) * 0.8;
  }
  return x;
}

/** Tones for a chord sequence, each note with a few harmonics. */
function progression(chords: number[][], seconds = 20): Float32Array {
  const x = new Float32Array(SR * seconds);
  const each = Math.floor(x.length / chords.length);
  chords.forEach((chord, c) => {
    for (const midi of chord) {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < each; i++) {
        const t = i / SR;
        x[c * each + i] += (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t)) * 0.12;
      }
    }
  });
  return x;
}

describe("tempo detection", () => {
  for (const bpm of [120, 122, 124, 126, 128, 130, 132, 135, 138, 140, 145]) {
    it(`finds ${bpm} BPM to within 1 BPM`, () => {
      expect(Math.abs(estimateTempo(pulse(bpm), SR).tempo - bpm)).toBeLessThanOrEqual(1);
    });
  }
});

describe("key detection", () => {
  it("finds A minor from i - VI - VII", () => {
    const k = estimateKey(computeChroma(progression([[57, 60, 64], [53, 57, 60], [55, 59, 62], [57, 60, 64]]), SR));
    expect(k).toEqual({ rootPitch: 9, mode: "minor" });
  });

  it("finds C major from I - IV - V", () => {
    const k = estimateKey(computeChroma(progression([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]), SR));
    expect(k).toEqual({ rootPitch: 0, mode: "major" });
  });

  it("finds a minor key for every root", () => {
    for (let root = 0; root < 12; root++) {
      const r = 48 + root;
      const k = estimateKey(computeChroma(progression([[r, r + 3, r + 7], [r + 5, r + 8, r + 12], [r + 7, r + 10, r + 14], [r, r + 3, r + 7]], 12), SR));
      expect(k.rootPitch).toBe(root);
      expect(k.mode).toBe("minor");
    }
  });
});
