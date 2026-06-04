/**
 * lib/audio-analysis.ts
 *
 * Analyses an uploaded audio file fully in the browser (no upload, no API)
 * and distils it into an AudioFeatures "DNA" vector.
 *
 * Pipeline:
 *   1. decode file → mono PCM via the Web Audio API
 *   2. RMS loudness            → energy
 *   3. spectral centroid (FFT) → brightness  (→ valence heuristic)
 *   4. onset-flux + tempo grid → tempo (BPM)
 *   5. onset regularity        → danceability
 *   6. high/low spectral ratio → acousticness heuristic
 *
 * Designed to degrade gracefully — a rough-but-plausible estimate is fine,
 * the point is genuine in-browser signal analysis driving the generator.
 */

import type { AudioFeatures } from "../types";

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export type AnalysisStatus = (msg: string) => void;

export async function analyseAudioFile(
  file: File,
  onStatus: AnalysisStatus = () => {}
): Promise<AudioFeatures> {
  onStatus(`[DECODE] ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);

  const arrayBuf = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const buffer = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  // down-mix to mono
  const len = buffer.length;
  const mono = new Float32Array(len);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  const sampleRate = buffer.sampleRate;

  onStatus("[RMS] Measuring loudness envelope…");
  const energy = computeEnergy(mono);

  onStatus("[FFT] Computing spectral centroid…");
  const { brightness, acousticness } = computeSpectral(mono, sampleRate);

  onStatus("[ONSET] Estimating tempo from onset flux…");
  const { tempo, danceability } = estimateTempo(mono, sampleRate);

  // valence heuristic: brighter + more energetic + faster ≈ happier
  const valence = clamp(brightness * 0.5 + energy * 0.3 + clamp((tempo - 90) / 90) * 0.2);

  const features: AudioFeatures = {
    tempo: Math.round(tempo),
    energy: clamp(energy),
    valence,
    danceability: clamp(danceability),
    acousticness: clamp(acousticness),
    brightness: clamp(brightness),
    source: file.name.replace(/\.[^.]+$/, "").slice(0, 22).toUpperCase(),
  };

  onStatus(
    `[DNA] tempo=${features.tempo} energy=${features.energy.toFixed(2)} ` +
      `valence=${features.valence.toFixed(2)} dance=${features.danceability.toFixed(2)}`
  );
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
  const hop = Math.floor(mono.length / 40) || N; // ~40 frames across the track
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
  const centroid = centroidAcc / frames; // Hz
  const highRatio = highRatioAcc / frames;

  // centroid ~500Hz (dark) .. ~5000Hz (bright)
  const brightness = clamp((centroid - 500) / 4500);
  // lots of high-freq energy → synthetic/electronic → low acousticness
  const acousticness = clamp(1 - highRatio * 1.6);
  return { brightness, acousticness };
}

/* ────────────────────────── tempo estimation ─────────────────────── */

function estimateTempo(mono: Float32Array, sampleRate: number): {
  tempo: number;
  danceability: number;
} {
  // build an onset-strength envelope from frame-to-frame energy increase
  const frame = 1024;
  const env: number[] = [];
  let prev = 0;
  for (let i = 0; i + frame < mono.length; i += frame) {
    let e = 0;
    for (let j = 0; j < frame; j++) e += mono[i + j] * mono[i + j];
    e = Math.sqrt(e / frame);
    env.push(Math.max(0, e - prev)); // half-wave rectified flux
    prev = e;
  }
  const envRate = sampleRate / frame; // envelope samples per second

  // autocorrelation over plausible BPM lags
  const minBpm = 80;
  const maxBpm = 175;
  let bestBpm = 120;
  let bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
    const lag = Math.round((60 / bpm) * envRate);
    if (lag < 1 || lag >= env.length) continue;
    let score = 0;
    for (let i = 0; i + lag < env.length; i++) score += env[i] * env[i + lag];
    // mild preference for ~120–130 to avoid octave errors
    score *= 1 - Math.abs(bpm - 125) / 600;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  // danceability: how peaky/regular the onset envelope is
  const mean = env.reduce((a, b) => a + b, 0) / (env.length || 1);
  const variance = env.reduce((a, b) => a + (b - mean) ** 2, 0) / (env.length || 1);
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
