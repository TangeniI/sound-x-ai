import { describe, expect, it } from "vitest";
import { matchedLowpass, peakEnvelope, truePeakDb, truePeakLimit } from "./master";

const sine = (n: number, cycles: number, amp: number, phase = 0) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * cycles * i + phase));

describe("true peak", () => {
  it("finds the peak between samples that a sample meter misses", () => {
    // a quarter of the sample rate, sampled 45 degrees off its crest: samples at 0.707, true peak 1
    const x = sine(4800, 0.25, 1, Math.PI / 4);
    expect(Math.max(...x)).toBeLessThan(0.71);
    expect(truePeakDb([x])).toBeGreaterThan(-0.2);
  });

  it("holds a loud mix under -1 dBTP and leaves a quiet one alone", () => {
    const rate = 48000;
    const loud = [sine(rate, 0.25, 0.85, Math.PI / 4), sine(rate, 997 / rate, 1.2)];
    const took = truePeakLimit(loud, { sampleRate: rate });
    expect(took).toBeGreaterThan(1);
    expect(truePeakDb(loud)).toBeLessThanOrEqual(-1);

    const quiet = [sine(rate, 440 / rate, 0.5)];
    const before = quiet[0].slice();
    expect(truePeakLimit(quiet, { sampleRate: rate })).toBe(0);
    expect(quiet[0]).toEqual(before);
  });

  it("only turns down around the peaks, easing in before them", () => {
    const rate = 48000;
    const x = sine(rate, 1000 / rate, 0.5);
    x[24000] = 1.4; // one spike in the middle
    truePeakLimit([x], { sampleRate: rate });
    expect(Math.abs(x[24000])).toBeLessThan(0.9);
    expect(Math.abs(x[23940]) / 0.5).toBeLessThan(Math.abs(Math.sin(2 * Math.PI * 1000 * 23940 / rate)) + 1e-6); // already easing 1.25 ms before
    expect(x[1000]).toBeCloseTo(0.5 * Math.sin(2 * Math.PI * 1000 * 1000 / rate), 6); // far away: untouched
  });

  it("limits a loop so its end runs into its start without a jump", () => {
    const rate = 48000;
    const n = rate;
    // whole cycles, so it loops; a smooth swell centred just after the top of the loop
    const x = sine(n, 100 / rate, 0.6, Math.PI / 3);
    for (let i = 0; i < n; i++) {
      const d = Math.min(Math.abs(i - 40), n - Math.abs(i - 40));
      if (d < 300) x[i] *= 1 + 0.6 * (1 + Math.cos((Math.PI * d) / 300));
    }
    const g = x.slice();
    truePeakLimit([g], { sampleRate: rate, loop: true });
    expect(Math.max(...peakEnvelope([g], 0, true))).toBeLessThanOrEqual(10 ** (-1 / 20));
    // the end of the loop is already easing down into the swell at its start
    expect(g[n - 1] / x[n - 1]).toBeLessThan(0.9);
    expect(Math.abs(g[n - 1] / x[n - 1] - g[0] / x[0])).toBeLessThan(0.01);
  });
});

describe("matched low-pass", () => {
  /** |H| in dB of a biquad at a frequency. */
  const gainDb = ({ feedforward: b, feedback: a }: { feedforward: number[]; feedback: number[] }, hz: number, rate: number) => {
    const w = (2 * Math.PI * hz) / rate;
    const num = Math.hypot(b[0] + b[1] * Math.cos(w) + b[2] * Math.cos(2 * w), b[1] * Math.sin(w) + b[2] * Math.sin(2 * w));
    const den = Math.hypot(a[0] + a[1] * Math.cos(w) + a[2] * Math.cos(2 * w), a[1] * Math.sin(w) + a[2] * Math.sin(2 * w));
    return 20 * Math.log10(num / den);
  };
  const analogDb = (fc: number, hz: number, q: number) => {
    const x = hz / fc;
    return -10 * Math.log10((1 - x * x) ** 2 + (x / q) ** 2);
  };

  it("follows the analog filter up to the top of the band", () => {
    for (const fc of [1000, 6000, 12000, 15000]) {
      const f = matchedLowpass(fc, 48000, 1.07);
      expect(gainDb(f, 0, 48000)).toBeCloseTo(0, 3);
      for (const hz of [500, 4000, 10000, 16000, 19000]) expect(Math.abs(gainDb(f, hz, 48000) - analogDb(fc, hz, 1.07))).toBeLessThan(1.2);
    }
  });
});
