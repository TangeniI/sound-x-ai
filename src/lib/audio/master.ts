/**
 * lib/audio/master.ts
 *
 * Signal processing done in plain TypeScript rather than with the browser's nodes.
 *
 * `truePeakLimit` holds an export's peaks *between* samples under -1 dBTP. The
 * soft ceiling in the graph only sees the samples themselves, and a converter
 * or an MP3 encoder rebuilds what lies between them.
 *
 * `matchedLowpass` gives the hits' velocity filters a response that follows the
 * analog curve to the top of the band, where the browser's own low-pass dulls it.
 */

/** Zeroth-order modified Bessel function, for the Kaiser window. */
function bessel0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const kaiser = (u: number, beta: number) => (Math.abs(u) > 1 ? 0 : bessel0(beta * Math.sqrt(1 - u * u)) / bessel0(beta));

/* ---------- true peak ---------- */

const OVERSAMPLE = 4;
const HALF = 16; // taps either side of the point being rebuilt: near Nyquist at 44.1 kHz, fewer read 0.1 dB low
/** Interpolation filters for the points a quarter, half and three quarters between samples. */
const PHASES: Float32Array[] = Array.from({ length: OVERSAMPLE - 1 }, (_, p) => {
  const d = (p + 1) / OVERSAMPLE;
  const h = new Float32Array(2 * HALF);
  let sum = 0;
  for (let k = -HALF + 1; k <= HALF; k++) {
    const t = d - k;
    const v = sinc(t) * kaiser(t / HALF, 8);
    h[k + HALF - 1] = v;
    sum += v;
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  return h;
});

/** Below this, a point between two samples can't come near the ceiling. */
const QUIET = 0.55;

/**
 * The highest absolute value at each sample and the three points after it,
 * across all channels: the true-peak meter of ITU-R BS.1770, per sample.
 * `wrap` reads past either end from the other end, for a seamless loop.
 */
export function peakEnvelope(channels: Float32Array[], threshold = 0, wrap = false): Float32Array<ArrayBuffer> {
  const n = channels[0].length;
  const env = new Float32Array(n);
  const at = wrap
    ? (x: Float32Array, i: number) => x[((i % n) + n) % n]
    : (x: Float32Array, i: number) => (i < 0 || i >= n ? 0 : x[i]);
  for (const x of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > env[i]) env[i] = a;
      const next = Math.abs(at(x, i + 1));
      if (Math.max(a, next) < threshold * QUIET) continue;
      const inside = i - HALF + 1 >= 0 && i + HALF < n;
      for (const h of PHASES) {
        let y = 0;
        if (inside) for (let k = 0; k < h.length; k++) y += x[i - HALF + 1 + k] * h[k];
        else for (let k = 0; k < h.length; k++) y += at(x, i - HALF + 1 + k) * h[k];
        const ay = Math.abs(y);
        if (ay > env[i]) env[i] = ay;
      }
    }
  }
  return env;
}

/** The true peak of a buffer, in dBTP. */
export function truePeakDb(channels: Float32Array[]): number {
  const env = peakEnvelope(channels);
  let max = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
  return 20 * Math.log10(max || 1e-12);
}

export interface LimitOptions {
  sampleRate: number;
  ceilingDb?: number;
  /** How early the gain starts to come down before a peak. */
  attackMs?: number;
  releaseMs?: number;
  /** Treat the buffer as a loop, so the gain at its end leads into its start. */
  loop?: boolean;
}

/**
 * A look-ahead true-peak limiter, in place. Offline, so it sees every peak
 * coming: the gain eases down before each one and recovers after it, never
 * above what the peak allows. Returns the most it took off, in dB.
 */
export function truePeakLimit(channels: Float32Array[], { sampleRate, ceilingDb = -1, attackMs = 1.5, releaseMs = 80, loop = false }: LimitOptions): number {
  const n = channels[0].length;
  if (!n) return 0;
  const ceiling = 10 ** ((ceilingDb - 0.15) / 20); // a hair under: meters interpolate differently
  const env = peakEnvelope(channels, ceiling, loop);
  const gain = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    gain[i] = env[i] > ceiling ? ceiling / env[i] : 1;
    if (gain[i] < 1) any = true;
  }
  if (!any) return 0;
  const att = Math.exp(-1 / ((attackMs / 1000) * sampleRate / 3)); // within about 5% by the peak
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  // a loop runs the smoothing round twice, so each end has the other's history
  const rounds = loop ? 2 : 1;
  for (let r = 0; r < rounds; r++) {
    for (let i = n - 2 + (loop ? 1 : 0); i >= 0; i--) {
      const ahead = gain[(i + 1) % n];
      const g = 1 - (1 - ahead) * att;
      if (g < gain[i]) gain[i] = g;
    }
    for (let i = loop ? 0 : 1; i < n; i++) {
      const before = gain[(i - 1 + n) % n];
      const g = 1 - (1 - before) * rel;
      if (g < gain[i]) gain[i] = g;
    }
  }
  let least = 1;
  for (const x of channels) for (let i = 0; i < n; i++) x[i] *= gain[i];
  for (let i = 0; i < n; i++) if (gain[i] < least) least = gain[i];
  return -20 * Math.log10(least);
}

/* ---------- a low-pass that doesn't dull the top ---------- */

/**
 * Coefficients for a second-order low-pass whose response matches the analog
 * filter all the way up (Vicanek, "Matched Second Order Digital Filters", 2016).
 * The browser's BiquadFilter uses the bilinear transform, which squeezes the
 * response to nothing at Nyquist: a 15 kHz low-pass at 48 kHz takes about 9 dB
 * more off at 19 kHz than the analog one. Every hat is filtered by velocity, so
 * that squeeze was most of the missing air. `q` is linear (0.707 = Butterworth).
 */
export function matchedLowpass(cutoff: number, sampleRate: number, q = 0.707): { feedforward: number[]; feedback: number[] } {
  const w0 = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.49)) / sampleRate;
  const z = 1 / (2 * q);
  const e = Math.exp(-z * w0);
  const a1 = z <= 1 ? -2 * e * Math.cos(Math.sqrt(1 - z * z) * w0) : -2 * e * Math.cosh(Math.sqrt(z * z - 1) * w0);
  const a2 = e * e;
  const A0 = (1 + a1 + a2) ** 2;
  const A1 = (1 - a1 + a2) ** 2;
  const A2 = -4 * a2;
  const s = Math.sin(w0 / 2) ** 2;
  const phi0 = 1 - s, phi1 = s, phi2 = 4 * phi0 * phi1;
  const R1 = (A0 * phi0 + A1 * phi1 + A2 * phi2) * q * q;
  const B0 = A0;
  const B1 = Math.max(0, (R1 - B0 * phi0) / phi1);
  const b0 = 0.5 * (Math.sqrt(B0) + Math.sqrt(B1));
  const b1 = Math.sqrt(B0) - b0;
  return { feedforward: [b0, b1, 0], feedback: [1, a1, a2] };
}
