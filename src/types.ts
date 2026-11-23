/**
 * src/types.ts
 * Single source of truth for shared types across components + lib.
 */

import type { Kit } from "./lib/audio/kits";

/** Normalised audio "DNA" — from the controls or from analysing a track. */
export interface AudioFeatures {
  tempo:        number; // BPM
  energy:       number; // 0–1  overall intensity
  valence:      number; // 0–1  dark → bright
  danceability: number; // 0–1  groove / rhythmic drive
  acousticness: number; // 0–1  organic vs. electronic
  brightness?:  number; // 0–1  spectral centroid (timbre)
  rootPitch?:   number; // 0–11 key root (C..B)
  mode?:        "major" | "minor"; // detected tonality
  source?:      string; // label for where this DNA came from
}

/** Mixer lanes. "fx" events (risers, impacts) sit outside the mixer. */
export type Lane = "drums" | "perc" | "bass" | "stab" | "lead" | "pad";
export type Instrument = Lane | "fx";
/** Mixer channels: the lanes, the rumble under the kick, and effects. */
export type ChannelId = Lane | "rumble" | "fx";
/** The drum sounds a producer can swap for another recording or one of their own. */
export type SoundSlot = "kick" | "snare" | "clap" | "rim" | "hat" | "open" | "perc" | "perc2" | "chord";
export const SOUND_SLOTS: SoundSlot[] = ["kick", "snare", "clap", "rim", "hat", "open", "perc", "perc2", "chord"];
export const LANES: Lane[] = ["lead", "pad", "stab", "bass", "perc", "drums"];

/** A single scheduled note. */
export interface NoteEvent {
  pitch:      number; // MIDI 0–127
  startTime:  number; // seconds, swing included
  endTime:    number; // seconds
  velocity:   number; // 0–127
  instrument: Instrument;
  step:       number; // absolute 16th-note index
  chord?:     number[]; // semitone offsets of a chord this note stands for
  accent?:    boolean; // acid: louder, brighter
  slide?:     boolean; // acid: glide in from the previous note
  variant?:   number;  // which recording or rhythm variant this note uses
}

/** Styles — each picks its own patterns and its own recorded kit. */
export type StyleId = "driving" | "hypnotic" | "acid" | "tribal" | "dub" | "warehouse";

/** The twelve Groove families. Each is built around one idea. */
export type FamilyId =
  | "backbone" | "floor" | "steel" | "night" | "hands" | "wire"
  | "concrete" | "signal" | "undertow" | "exhaust" | "clockwork" | "splinter";

export type ModeChoice = "auto" | "minor" | "major";

export interface GeneratorConfig {
  style:      StyleId;
  family?:    FamilyId; // Groove only; without one the seed decides
  bars:       number;  // arrangement length
  tempo:      number;  // BPM
  energy:     number;  // 0–1  intensity: layers, velocity, drive, rumble
  valence:    number;  // 0–1  mood: dark scales → bright scales
  density:    number;  // 0–1  rhythmic busyness
  variation:  number;  // 0–1  riff temperature + pattern mutation
  rootPitch:  number;  // MIDI pitch class 0–11 (C..B)
  mode:       ModeChoice; // "auto" follows the mood slider
  seed:       number;  // the take: same seed + same controls = same track
  laneSeeds:  Partial<Record<Lane, number>>; // re-rolled single lanes
  pins:       Record<number, number>; // riff step → vocab token held by the user
  levels?:    Partial<Record<ChannelId, number>>; // fader positions in dB, 0 if not set
  /** Swapped sounds: a recording's id, or `user:…` for one kept on this device. */
  sounds?:    Partial<Record<SoundSlot, string>>;
  /** Groove only: the DJ version, five minutes of track inside 32 bars of drums at each end. */
  dj?:        boolean;
}

/** One piano-roll edit, kept apart from the notes so it survives regeneration. */
export interface NoteEdit {
  op:    "add" | "remove";
  lane:  Lane;
  step:  number;
  pitch: number;
  root?: number; // the key it was made in, so it follows a key change
}

export type SectionKind = "intro" | "groove" | "riff" | "break" | "build" | "drop" | "outro";

export interface Section {
  kind:     SectionKind;
  startBar: number;
  bars:     number;
}

/** A mix move in the arrangement: filter sweeps, reverb swells, echo throws. */
export interface Automation {
  time:  number;
  param: "cutoff" | "space" | "echo" | "acid" | "low"; // low: the rumble gate, shut before a hit
  from:  number; // where the move starts, so it never depends on playback history
  value: number;
  ramp:  number; // seconds
}

/** Live mix settings derived from the controls. */
export interface MixParams {
  drive:      number; // 0–1  drum bus saturation
  rumble:     number; // 0–1  level of the sub rumble chain
  space:      number; // 0–1  hall send
  echo:       number; // 0–1  tape echo send
  brightness: number; // 0–1  filter opening on stabs + leads
  pump:       number; // 0–1  sidechain depth
  kickTune:   number; // semitones, tunes the kick to the key
  rumbleTune: number; // semitones, tunes the sub layer to the key
}

/** What the riff model did, kept so the UI can show it. */
export interface RiffInfo {
  neural:  boolean;
  tokens:  number[];          // chosen vocab index per step
  vocab:   (number | null)[]; // scale degree per token, null = rest
  probs:   number[][];        // distribution the model sampled from, per step
  temperature: number;
}

export interface Track {
  config:     GeneratorConfig;
  notes:      NoteEvent[];
  sections:   Section[];
  automation: Automation[];
  bpm:        number;
  stepSec:    number;
  durationSec: number;
  root:       number; // pitch class
  tonality:   "minor" | "major";
  scale:      readonly number[];
  mix:        MixParams;
  kit:        Kit; // the recordings this take plays
  endKit?:    { from: number; kit: Kit }; // Groove: the sounds it changes to from this step
  family?:    { id: FamilyId; name: string; about: string };
  riff:       RiffInfo;
}
