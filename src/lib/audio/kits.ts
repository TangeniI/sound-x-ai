/**
 * lib/audio/kits.ts
 *
 * Which recordings each style plays, and how they are shaped.
 *
 * Chord samples are real recorded chords. They are repitched as a block, the way
 * producers played a single chord across a hardware sampler. Roots below were
 * measured from the recordings, not read from their file names.
 */

import type { StyleId } from "../../types";

export interface Zone { id: string; root: number }

export interface BassVoice {
  id:     string;
  cutoff: number;  // Hz, resting filter
  sweep:  number;  // Hz, added by the filter envelope
  q:      number;
  decay:  number;  // seconds
  acid:   boolean; // two filters in series + accent + slide
}

export interface LeadVoice {
  zones:  Zone[];
  cutoff: number;
  decay:  number;
  gain:   number;
}

export interface Kit {
  kick:   string;
  kickRoot: number;  // measured pitch of the kick's body
  kickLen?: number;  // seconds, tightens a long kick
  clap:   string;
  rim:    string;
  hatC:   string;
  hatO:   string;
  ride:   string;
  perc:   [string, string, string];
  percGain: number;
  bass:   BassVoice;
  chord:  Zone | null;  // null = voice the chord note by note on the TX81Z
  pad:    Zone;
  lead:   LeadVoice;
  /** Share of the kit level sent to hall / echo, per lane. */
  sends:  { stab: [number, number]; lead: [number, number]; perc: [number, number] };
}

export const FM: Zone[] = [
  { id: "fm_c3", root: 48 },
  { id: "fm_c4", root: 60 },
  { id: "fm_c5", root: 72 },
];

/** Measured pitch of the long 808 kick behind the rumble (49.8 Hz). */
export const RUMBLE_ROOT = 31.3;

const CLAVI: Zone[] = [
  { id: "clavi_c5", root: 72 },
  { id: "clavi_c6", root: 84 },
];

const EM9: Zone = { id: "chord_em9", root: 40 };
const GM_HIGH: Zone = { id: "chord_high", root: 67 };
const PAD_LOW: Zone = { id: "pad_1", root: 43 };
const PAD_MID: Zone = { id: "pad_2", root: 55 };
const PAD_DARK: Zone = { id: "pad_3", root: 55 };

export const KITS: Record<StyleId, Kit> = {
  driving: {
    kick: "kick_909_atk", kickRoot: 32.5, clap: "clap_909", rim: "rim_909", hatC: "hat_909_c", hatO: "hat_909_o", ride: "ride_909",
    perc: ["rim_909", "perc_tap", "shaker"], percGain: 1.25,
    bass: { id: "bass_hard", cutoff: 340, sweep: 900, q: 3, decay: 0.16, acid: false },
    chord: GM_HIGH, pad: PAD_MID,
    lead: { zones: CLAVI, cutoff: 3600, decay: 0.32, gain: 0.5 },
    sends: { stab: [0.28, 0.3], lead: [0.2, 0.32], perc: [0.12, 0.1] },
  },
  hypnotic: {
    kick: "kick_klub", kickRoot: 31.5, kickLen: 0.27, clap: "clap_808", rim: "rim_808", hatC: "hat_808_c", hatO: "hat_808_o", ride: "ride_909",
    perc: ["perc_blip", "perc_tap", "shaker"], percGain: 1.25,
    bass: { id: "bass_thick", cutoff: 260, sweep: 420, q: 2, decay: 0.2, acid: false },
    chord: EM9, pad: PAD_DARK,
    lead: { zones: FM, cutoff: 2200, decay: 0.26, gain: 0.62 },
    sends: { stab: [0.3, 0.55], lead: [0.25, 0.5], perc: [0.18, 0.3] },
  },
  acid: {
    kick: "kick_909", kickRoot: 32.5, clap: "clap_808", rim: "rim_909", hatC: "hat_909_c", hatO: "hat_909_o", ride: "ride_909",
    perc: ["cowbell_808", "rim_909", "shaker"], percGain: 1.25,
    bass: { id: "bass_hard", cutoff: 240, sweep: 2400, q: 11, decay: 0.2, acid: true },
    chord: null, pad: PAD_DARK,
    lead: { zones: CLAVI, cutoff: 3000, decay: 0.24, gain: 0.34 },
    sends: { stab: [0.2, 0.3], lead: [0.18, 0.4], perc: [0.1, 0.12] },
  },
  melodic: {
    kick: "kick_909", kickRoot: 32.5, clap: "clap_hands", rim: "rim_808", hatC: "hat_909_c", hatO: "hat_909_o", ride: "ride_909",
    perc: ["shaker", "perc_tap", "rim_808"], percGain: 1.25,
    bass: { id: "bass_trance", cutoff: 420, sweep: 520, q: 1.4, decay: 0.28, acid: false },
    chord: null, pad: PAD_MID,
    lead: { zones: CLAVI, cutoff: 4200, decay: 0.4, gain: 0.42 },
    sends: { stab: [0.4, 0.38], lead: [0.38, 0.4], perc: [0.16, 0.18] },
  },
  dub: {
    kick: "kick_klub", kickRoot: 31.5, kickLen: 0.27, clap: "clap_808", rim: "rim_808", hatC: "hat_808_c", hatO: "hat_808_o", ride: "ride_909",
    perc: ["perc_tap", "shaker", "perc_blip"], percGain: 1.25,
    bass: { id: "bass_trance", cutoff: 300, sweep: 180, q: 1, decay: 0.42, acid: false },
    chord: EM9, pad: PAD_LOW,
    lead: { zones: FM, cutoff: 1500, decay: 0.3, gain: 0.5 },
    sends: { stab: [0.42, 0.85], lead: [0.3, 0.7], perc: [0.2, 0.42] },
  },
  warehouse: {
    kick: "kick_tek", kickRoot: 40.3, clap: "clap_hands", rim: "rim_909", hatC: "hat_raw", hatO: "hat_909_o", ride: "ride_909",
    perc: ["anvil", "brake_drum", "tom_808"], percGain: 0.75,
    bass: { id: "bass_thick", cutoff: 180, sweep: 260, q: 2.4, decay: 0.2, acid: false },
    chord: GM_HIGH, pad: PAD_DARK,
    lead: { zones: CLAVI, cutoff: 1900, decay: 0.2, gain: 0.34 },
    sends: { stab: [0.5, 0.32], lead: [0.3, 0.3], perc: [0.42, 0.24] },
  },
};

/** Everything every style shares: the rooms, the rumble source, the transitions. */
const SHARED = [
  "ir_hall", "ir_room", "kick_808_long", "vinyl", "gong", "gong_scrape", "boom", "crash_909",
  "cymbal_808_long", "fx_bed",
];

export function kitSamples(style: StyleId): string[] {
  const k = KITS[style];
  return [
    ...SHARED, k.kick, k.clap, k.rim, k.hatC, k.hatO, k.ride, ...k.perc, k.bass.id,
    k.pad.id, ...k.lead.zones.map((z) => z.id),
    ...(k.chord ? [k.chord.id] : FM.map((z) => z.id)),
  ];
}

/** Major keys can't use the minor chord recordings, so they are voiced on the TX81Z. */
export function allSamplesFor(style: StyleId, tonality: "minor" | "major"): string[] {
  return tonality === "major" ? [...kitSamples(style), ...FM.map((z) => z.id)] : kitSamples(style);
}

/** Closest zone to a pitch, plus the playback rate that lands on it. */
export function pickZone(zones: Zone[], pitch: number): { id: string; rate: number } {
  let best = zones[0];
  for (const z of zones) if (Math.abs(z.root - pitch) < Math.abs(best.root - pitch)) best = z;
  return { id: best.id, rate: 2 ** ((pitch - best.root) / 12) };
}

/** Rate that moves a sampled chord to a new root by the smallest interval. */
export function chordRate(zone: Zone, pitch: number): number {
  const semis = ((pitch - zone.root) % 12 + 18) % 12 - 6;
  return 2 ** (semis / 12);
}
