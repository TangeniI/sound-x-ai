/**
 * src/types.ts
 * Single source of truth for shared types across components + lib.
 */

/** Normalised audio "DNA" — from the controls or from analysing a track. */
export interface AudioFeatures {
  tempo:        number; // BPM
  energy:       number; // 0–1  overall intensity
  valence:      number; // 0–1  dark → bright (also minor → major)
  danceability: number; // 0–1  groove / rhythmic drive
  acousticness: number; // 0–1  organic vs. electronic
  brightness?:  number; // 0–1  spectral centroid (timbre)
  rootPitch?:   number; // 0–11 detected key root (C..B)
  mode?:        "major" | "minor"; // detected tonality
  beats?:       { start: number; duration: number }[];
  source?:      string; // label for where this DNA came from
}

/** Instrument lanes the engine writes to. ("fx" = risers/impacts, not shown on the timeline.) */
export type Instrument = "lead" | "stab" | "bass" | "drums" | "fx";

/** A single scheduled note. */
export interface NoteEvent {
  pitch:      number; // MIDI 0–127
  startTime:  number; // seconds
  endTime:    number; // seconds
  velocity:   number; // 0–127
  instrument: Instrument;
}

/** Techno style presets — each reshapes the whole arrangement. */
export type StyleId = "driving" | "hypnotic" | "acid" | "melodic";

export interface GeneratorConfig {
  style:         StyleId;
  bars:          number;  // arrangement length
  tempo:         number;  // BPM
  energy:        number;  // 0–1
  valence:       number;  // 0–1  (mood: minor/dark → major/bright)
  density:       number;  // 0–1  rhythmic busyness
  variation:     number;  // 0–1  amount of pattern mutation
  rootPitch:     number;  // MIDI pitch class 0–11 (C..B)
  seedFromAudio: boolean; // condition on analysed upload when available
}
