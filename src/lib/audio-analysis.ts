/**
 * lib/audio-analysis.ts
 *
 * Analyses an uploaded audio file fully in the browser (no upload, no API)
 * and distils it into an AudioFeatures "DNA" vector.
 *
 * Pipeline:
 *   1. decode file → mono PCM via the Web Audio API
 *   2. RMS loudness             → energy
 *   3. spectral centroid (FFT)  → brightness (→ valence heuristic)
 *   4. onset envelope + comb    → tempo, resolved to a fraction of a BPM
 *   5. chroma + key profiles    → key and mode (Krumhansl-Schmuckler)
 *   6. onset regularity         → danceability
 *   7. high/low spectral ratio  → acousticness heuristic
 *
 * The DSP functions take plain sample arrays, so they are tested without a browser.
 */

import type { AudioFeatures } from "../types";

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export type AnalysisStatus = (msg: string) => void;

/** Give the page a frame between heavy stages so the UI keeps moving. */
const breathe = () => new Promise((r) => setTimeout(r, 0));

export async function analyseAudioFile(
  file: File,
  onStatus: AnalysisStatus = () => {}
): Promise<AudioFeatures> {
  onStatus(`Decoding ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);

  const arrayBuf = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuf);
  } finally {
    void ctx.close();
  }

  // down-mix to mono
  const len = buffer.length;
  const mono = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  const sampleRate = buffer.sampleRate;

  onStatus("Measuring loudness");
  await breathe();
  const energy = computeEnergy(mono);

  onStatus("Reading the spectrum");
  await breathe();
  const { brightness, acousticness } = computeSpectral(mono, sampleRate);

  onStatus("Finding the key");
  await breathe();
  const { rootPitch, mode } = estimateKey(computeChroma(mono, sampleRate));

  onStatus("Finding the tempo");
  await breathe();
  // two minutes from the middle is plenty, and keeps long files quick
  const span = Math.min(mono.length, 120 * sampleRate);
  const from = Math.floor((mono.length - span) / 2);
  const { tempo, danceability } = estimateTempo(mono.subarray(from, from + span), sampleRate);

  // valence heuristic: brighter + more energetic + faster ≈ happier
  const valence = clamp(brightness * 0.5 + energy * 0.3 + clamp((tempo - 90) / 90) * 0.2);

  const features: AudioFeatures = {
    tempo: Math.round(tempo),
    energy: clamp(energy),
    valence,
    danceability: clamp(danceability),
    acousticness: clamp(acousticness),
    brightness: clamp(brightness),
    rootPitch,
    mode,
    source: file.name.replace(/\.[^.]+$/, "").slice(0, 22).toUpperCase(),
  };

  onStatus(`${features.tempo} BPM, ${KEYS[rootPitch]} ${mode}`);
  return features;
}

/* ───────────────────────── energy / loudness ─────────────────────── */

function computeEnergy(mono: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < mono.length; i++) sum += mono[i] * mono[i];
  const rms = Math.sqrt(sum / mono.length);
  // RMS ~0.02 (quiet) .. ~0.35 (loud master) → map to 0–1
  return clamp((rms - 0.01) / 0.28);
}

/* ────────────────────── spectral analysis (DFT) ──────────────────── */

function computeSpectral(mono: Float32Array, sampleRate: number): {
  brightness: number;
  acousticness: number;
} {
  const N = 4096;
  const hop = Math.floor(mono.length / 60) || N; // ~60 frames across the track
  const window = hann(N);

  let centroidAcc = 0;
  let highRatioAcc = 0;
  let frames = 0;

  const re = new Float32Array(N);
  const im = new Float32Array(N);

  for (let start = 0; start + N < mono.length; start += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);

    let magSum = 0;
    let weighted = 0;
    let highSum = 0;
    let lowSum = 0;
    const cutoffBin = Math.floor((2000 / (sampleRate / 2)) * (N / 2));
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const freq = (k * sampleRate) / N;
      magSum += mag;
      weighted += mag * freq;
      if (k > cutoffBin) highSum += mag;
      else lowSum += mag;
    }
    if (magSum > 0) {
      centroidAcc += weighted / magSum;
      highRatioAcc += highSum / (highSum + lowSum + 1e-9);
      frames++;
    }
  }

  if (frames === 0) return { brightness: 0.5, acousticness: 0.5 };
  const centroid = centroidAcc / frames;
  const highRatio = highRatioAcc / frames;
  return {
    brightness: clamp((centroid - 500) / 4500),
    acousticness: clamp(1 - highRatio * 1.6),
  };
}

/* ──────────────────────────── key finding ────────────────────────── */

// Krumhansl-Kessler probe-tone profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Pitch-class energy across the track. A long FFT resolves semitones in the bass,
 * and only spectral peaks are counted, so noise and hats don't blur the result.
 */
export function computeChroma(mono: Float32Array, sampleRate: number): number[] {
  const N = 16384;
  const chroma = new Array(12).fill(0);
  if (mono.length < N) return chroma;
  const hop = Math.max(N, Math.floor(mono.length / 90));
  const window = hann(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const C0 = 16.3516;
  const lo = Math.ceil((110 * N) / sampleRate);  // above the kick's body
  const hi = Math.floor((1500 * N) / sampleRate);

  for (let start = 0; start + N <= mono.length; start += hop) {
    for (let i = 0; i < N; i++) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(hi + 2);
    for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let k = lo; k <= hi; k++) {
      if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      // parabolic interpolation places the peak between bins
      const d = (mag[k - 1] - mag[k + 1]) / (2 * (mag[k - 1] - 2 * mag[k] + mag[k + 1]) || 1);
      const hz = ((k + d) * sampleRate) / N;
      const pc = ((Math.round(12 * Math.log2(hz / C0)) % 12) + 12) % 12;
      chroma[pc] += mag[k];
    }
  }
  return chroma;
}

function correlate(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) || 1);
}

/** Best match over all 24 keys. Dance music is mostly minor, so minor gets a small lead. */
export function estimateKey(chroma: number[]): { rootPitch: number; mode: "major" | "minor" } {
  let best = -Infinity;
  let result: { rootPitch: number; mode: "major" | "minor" } = { rootPitch: 0, mode: "minor" };
  for (let root = 0; root < 12; root++) {
    const rotated = chroma.map((_, i) => chroma[(i + root) % 12]);
    const minor = correlate(rotated, MINOR_PROFILE) + 0.03;
    const major = correlate(rotated, MAJOR_PROFILE);
    if (minor > best) { best = minor; result = { rootPitch: root, mode: "minor" }; }
    if (major > best) { best = major; result = { rootPitch: root, mode: "major" }; }
  }
  return result;
}

/* ────────────────────────── tempo estimation ─────────────────────── */

/** Half-wave rectified energy flux, weighted to the kick's frequency range. */
function onsetEnvelope(mono: Float32Array, sampleRate: number): { env: Float32Array; rate: number } {
  const hop = Math.round(sampleRate / 200);
  const frames = Math.floor(mono.length / hop);
  const env = new Float32Array(frames);
  // one-pole low-pass keeps the kick and bass, where the pulse lives
  const a = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
  let lp = 0, prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < hop; i++) {
      const x = mono[f * hop + i];
      lp += a * (x - lp);
      e += lp * lp + 0.08 * x * x;
    }
    const level = Math.log1p(e * 40);
    env[f] = Math.max(0, level - prev);
    prev = level;
  }
  return { env, rate: sampleRate / hop };
}

/** Linear interpolation lets the comb land between envelope frames. */
function sampleAt(env: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  if (i + 1 >= env.length) return 0;
  const t = pos - i;
  return env[i] * (1 - t) + env[i + 1] * t;
}

/** How well the envelope lines up with itself every 1, 2, 4 and 8 beats at `bpm`. */
function combScore(env: Float32Array, rate: number, bpm: number): number {
  const beat = (60 / bpm) * rate;
  let score = 0;
  for (const multiple of [1, 2, 4, 8]) {
    const lag = beat * multiple;
    let s = 0;
    for (let i = 0; i + lag < env.length - 1; i += 2) s += env[i] * sampleAt(env, i + lag);
    score += s;
  }
  return score;
}

export function estimateTempo(mono: Float32Array, sampleRate: number): {
  tempo: number;
  danceability: number;
} {
  const { env, rate } = onsetEnvelope(mono, sampleRate);
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  for (let i = 0; i < env.length; i++) env[i] -= mean; // otherwise every lag scores well

  // coarse sweep, then a fine sweep around the best candidate
  let bestBpm = 120, bestScore = -Infinity;
  for (let bpm = 80; bpm <= 180; bpm += 0.5) {
    const prior = 1 - Math.abs(bpm - 128) / 500; // a mild pull towards dance tempos
    const score = combScore(env, rate, bpm) * prior;
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }
  for (let bpm = bestBpm - 0.6; bpm <= bestBpm + 0.6; bpm += 0.05) {
    const score = combScore(env, rate, bpm);
    if (score > bestScore) { bestScore = score; bestBpm = bpm; }
  }

  // danceability: how peaky/regular the onset envelope is
  let variance = 0;
  for (let i = 0; i < env.length; i++) variance += env[i] * env[i];
  variance /= env.length || 1;
  const danceability = clamp(Math.sqrt(variance) / (mean + 1e-6) / 4);

  return { tempo: bestBpm, danceability };
}

/* ─────────────────────────── DSP helpers ─────────────────────────── */

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** In-place iterative radix-2 Cooley–Tukey FFT (N must be a power of 2). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
