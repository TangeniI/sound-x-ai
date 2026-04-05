/**
 * lib/taste-profile.ts
 *
 * Builds a "Musical DNA" profile from a user's Spotify listening history.
 *
 * Pipeline:
 *   1. Receive RawTrackFeatures[] (from spotify.ts → fetchEnrichedHistory)
 *   2. Compute weighted statistics across all features
 *   3. Cluster tracks into stylistic buckets (sparse K-means, k=3)
 *   4. Derive Magenta conditioning parameters from the profile
 *   5. Return a TasteProfile object consumed by magenta-engine.ts
 *
 * Pure functions — no side-effects, no imports beyond types.
 */

import type { RawTrackFeatures } from "./spotify";

/* ─── output types ──────────────────────────────────────────────────────── */

export interface FeatureStats {
  mean:   number;
  median: number;
  std:    number;
  min:    number;
  max:    number;
}

export interface StyleCluster {
  label:       string;  // e.g. "HIGH ENERGY", "CHILL", "ACOUSTIC"
  trackCount:  number;
  centroid:    FeatureVector;
  dominance:   number;  // 0–1 fraction of history
}

export interface FeatureVector {
  tempo:        number;
  energy:       number;
  valence:      number;
  danceability: number;
  acousticness: number;
}

export interface MagentaCondition {
  /** MelodyRNN temperature — higher = more exploratory */
  melodyTemperature: number;
  /** DrumRNN steps density seed (1 = sparse, 4 = busy) */
  drumDensity:       number;
  /** MusicVAE latent vector bias: [energy, valence] nudge */
  latentBias:        [number, number];
  /** Recommended BPM for Tone.js transport */
  bpm:               number;
  /** Synth brightness (0-1), mapped from valence + energy */
  brightness:        number;
}

export interface TasteProfile {
  trackCount:     number;
  stats:          Record<keyof FeatureVector, FeatureStats>;
  meanVector:     FeatureVector;
  clusters:       StyleCluster[];
  dominantCluster: StyleCluster;
  magenta:        MagentaCondition;
  /** ISO timestamp when this profile was computed */
  computedAt:     string;
}

/* ─── internal maths helpers ────────────────────────────────────────────── */

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function std(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0;
  const m   = mu ?? mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}

function featureStats(values: number[]): FeatureStats {
  const mu = mean(values);
  return {
    mean:   mu,
    median: median(values),
    std:    std(values, mu),
    min:    Math.min(...values),
    max:    Math.max(...values),
  };
}

function euclidean(a: FeatureVector, b: FeatureVector): number {
  const keys: (keyof FeatureVector)[] = ["energy", "valence", "danceability", "acousticness"];
  // normalise tempo to 0-1 before distance (range ~60-200 BPM → /140)
  const tDiff = ((a.tempo - 60) / 140) - ((b.tempo - 60) / 140);
  return Math.sqrt(
    keys.reduce((acc, k) => acc + (a[k] - b[k]) ** 2, 0) + tDiff ** 2
  );
}

/* ─── K-means (k=3) ─────────────────────────────────────────────────────── */

const K = 3;
const MAX_ITER = 30;

// Seeds chosen to represent typical musical clusters
const INITIAL_CENTROIDS: FeatureVector[] = [
  { tempo: 140, energy: 0.85, valence: 0.7,  danceability: 0.8,  acousticness: 0.05 }, // HIGH ENERGY
  { tempo: 90,  energy: 0.35, valence: 0.45, danceability: 0.40, acousticness: 0.65 }, // CHILL / ACOUSTIC
  { tempo: 115, energy: 0.60, valence: 0.55, danceability: 0.65, acousticness: 0.25 }, // MID / BALANCED
];

const CLUSTER_LABELS = ["HIGH ENERGY", "CHILL", "BALANCED"];

function assignClusters(vectors: FeatureVector[], centroids: FeatureVector[]): number[] {
  return vectors.map((v) => {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = euclidean(v, centroids[c]);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  });
}

function recomputeCentroids(
  vectors:     FeatureVector[],
  assignments: number[]
): FeatureVector[] {
  return Array.from({ length: K }, (_, c) => {
    const group = vectors.filter((_, i) => assignments[i] === c);
    if (group.length === 0) return INITIAL_CENTROIDS[c];
    // Build explicitly — Object.fromEntries loses the FeatureVector shape for TS
    const centroid: FeatureVector = {
      tempo:        mean(group.map((v) => v.tempo)),
      energy:       mean(group.map((v) => v.energy)),
      valence:      mean(group.map((v) => v.valence)),
      danceability: mean(group.map((v) => v.danceability)),
      acousticness: mean(group.map((v) => v.acousticness)),
    };
    return centroid;
  });
}

function kMeans(vectors: FeatureVector[]): { assignments: number[]; centroids: FeatureVector[] } {
  let centroids   = [...INITIAL_CENTROIDS];
  let assignments = assignClusters(vectors, centroids);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const newCentroids   = recomputeCentroids(vectors, assignments);
    const newAssignments = assignClusters(vectors, newCentroids);

    // Convergence check
    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    centroids   = newCentroids;
    assignments = newAssignments;
    if (!changed) break;
  }

  return { assignments, centroids };
}

/* ─── main export ───────────────────────────────────────────────────────── */

/**
 * Build a complete TasteProfile from enriched listening history.
 *
 * @param tracks  Output of spotify.ts → fetchEnrichedHistory()
 * @returns       TasteProfile consumed by magenta-engine.ts
 */
export function buildTasteProfile(tracks: RawTrackFeatures[]): TasteProfile {
  if (tracks.length === 0) {
    return buildDefaultProfile();
  }

  const vectors: FeatureVector[] = tracks.map((t) => ({
    tempo:        t.tempo,
    energy:       t.energy,
    valence:      t.valence,
    danceability: t.danceability,
    acousticness: t.acousticness,
  }));

  // ── per-feature statistics ────────────────────────────────────────────
  const statsKeys: (keyof FeatureVector)[] = [
    "tempo", "energy", "valence", "danceability", "acousticness",
  ];

  const stats = Object.fromEntries(
    statsKeys.map((k) => [k, featureStats(vectors.map((v) => v[k]))])
  ) as Record<keyof FeatureVector, FeatureStats>;

  const meanVector: FeatureVector = {
    tempo:        stats.tempo.mean,
    energy:       stats.energy.mean,
    valence:      stats.valence.mean,
    danceability: stats.danceability.mean,
    acousticness: stats.acousticness.mean,
  };

  // ── clustering ────────────────────────────────────────────────────────
  const { assignments, centroids } = kMeans(vectors);

  const clusters: StyleCluster[] = centroids.map((centroid, c) => {
    const count = assignments.filter((a) => a === c).length;
    return {
      label:      CLUSTER_LABELS[c],
      trackCount: count,
      centroid,
      dominance:  count / tracks.length,
    };
  });

  const dominantCluster = clusters.reduce((best, c) =>
    c.dominance > best.dominance ? c : best
  );

  // ── derive Magenta conditioning ───────────────────────────────────────
  const magenta = deriveMagentaCondition(meanVector, dominantCluster);

  return {
    trackCount: tracks.length,
    stats,
    meanVector,
    clusters,
    dominantCluster,
    magenta,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Build a real-time profile from a single track's audio features.
 * Used when "Seed from Spotify" is enabled in the GeneratorPanel.
 */
export function buildSingleTrackProfile(
  features: Pick<RawTrackFeatures, "tempo" | "energy" | "valence" | "danceability" | "acousticness">
): TasteProfile {
  return buildTasteProfile([
    {
      id:     "live",
      title:  "Current Track",
      artist: "",
      ...features,
    },
  ]);
}

/**
 * Derive Magenta conditioning parameters from a feature vector + dominant cluster.
 */
export function deriveMagentaCondition(
  vec:     FeatureVector,
  cluster: StyleCluster
): MagentaCondition {
  // MelodyRNN temperature: high energy + high valence → more exploratory
  const melodyTemperature = clamp(
    0.6 + vec.energy * 0.4 + vec.valence * 0.2 - vec.acousticness * 0.2
  );

  // DrumRNN density: danceability drives busyness
  // Maps to 1 (sparse) – 4 (busy) via danceability
  const drumDensity = clamp(1 + vec.danceability * 3, 1, 4);

  // MusicVAE latent bias: nudge toward listener's taste in 2D [energy, valence]
  const latentBias: [number, number] = [
    (vec.energy  - 0.5) * 2, // centred on 0
    (vec.valence - 0.5) * 2,
  ];

  // BPM: weighted blend of mean tempo + cluster centroid tempo
  const bpm = Math.round(
    vec.tempo * 0.6 + cluster.centroid.tempo * 0.4
  );

  // Synth brightness: high valence + low acousticness = brighter tone
  const brightness = clamp(vec.valence * 0.6 + (1 - vec.acousticness) * 0.4);

  return { melodyTemperature, drumDensity, latentBias, bpm, brightness };
}

/* ─── default profile (no history) ─────────────────────────────────────── */

function buildDefaultProfile(): TasteProfile {
  const def: FeatureVector = {
    tempo: 120, energy: 0.6, valence: 0.5, danceability: 0.6, acousticness: 0.25,
  };
  const defaultStats: FeatureStats = { mean: 0.5, median: 0.5, std: 0, min: 0.5, max: 0.5 };
  const defaultCluster: StyleCluster = {
    label: "BALANCED", trackCount: 0, centroid: def, dominance: 1,
  };
  return {
    trackCount:      0,
    stats:           { tempo: { mean: 120, median: 120, std: 0, min: 120, max: 120 }, energy: defaultStats, valence: defaultStats, danceability: defaultStats, acousticness: defaultStats },
    meanVector:      def,
    clusters:        [defaultCluster],
    dominantCluster: defaultCluster,
    magenta:         deriveMagentaCondition(def, defaultCluster),
    computedAt:      new Date().toISOString(),
  };
}