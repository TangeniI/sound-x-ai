/**
 * src/types.ts
 * Single source of truth for shared types across components + lib.
 * Import from here — never redefine these locally.
 */

/** Normalised audio "DNA" — produced by the controls or by analysing an
 *  uploaded audio file in-browser. All fields except tempo are 0–1. */
export interface AudioFeatures {
  tempo:        number; // BPM
  energy:       number; // 0–1  overall intensity / loudness
  valence:      number; // 0–1  musical positivity (dark → bright, minor → major)
  danceability: number; // 0–1  rhythmic regularity / groove
  acousticness: number; // 0–1  organic vs. electronic timbre
  brightness?:  number; // 0–1  spectral centroid (timbre openness)
  beats?:       { start: number; duration: number }[];
  /** label shown in the UI for where this DNA came from */
  source?:      string;
}

/** A single scheduled note across any instrument lane. */
export interface NoteEvent {
  pitch:      number; // MIDI 0–127
  startTime:  number; // seconds
  endTime:    number; // seconds
  velocity:   number; // 0–127
  instrument: "melody" | "chords" | "drums";
}

/** Which generation engine to run. */
export type EngineId =
  | "instant"        // bespoke in-house engine — full arrangement, instant
  | "magenta-vae"    // Google MusicVAE latent sampling (deep mode)
  | "magenta-melody" // Google MelodyRNN continuation (deep mode)
  | "magenta-drums"; // Google DrumsRNN continuation (deep mode)

/** Musical mode used by the bespoke engine. */
export type ScaleId =
  | "natural-minor"
  | "harmonic-minor"
  | "dorian"
  | "major"
  | "lydian"
  | "phrygian";

export interface GeneratorConfig {
  engine:        EngineId;
  bars:          number;  // arrangement length
  tempo:         number;  // BPM
  energy:        number;  // 0–1
  valence:       number;  // 0–1
  density:       number;  // 0–1  rhythmic busyness
  variation:     number;  // 0–1  Markov temperature
  rootPitch:     number;  // MIDI pitch class 0–11 (C..B)
  seedFromAudio: boolean; // condition on analysed upload when available
}
