/**
 * lib/audio/kits.ts
 *
 * Which recordings each style plays, and how they are shaped. Each Groove family
 * starts from the Groove kit and changes it (lib/groove/families.ts).
 *
 * There is no bass preset. As in a warehouse track, the low end is made from
 * drums: the tail of an analogue 808 kick for the sub, and a short filtered hit
 * for the part you hear on small speakers. Roots below were measured from the
 * recordings, not read from their file names.
 */

import type { SoundSlot, StyleId, Track } from "../../types";

export interface Zone { id: string; root: number }

export interface BassVoice {
  /** The sub's level and how fast it dies away, in seconds. */
  sub:    number;
  decay:  number;
  /** A recorded hit, band-passed, that gives the note its knock. */
  body?:  { id: string; gain: number; tone: number; rate: number };
  /** The 808 tail driven to a square, through two sweeping filters. */
  acid?:  { cutoff: number; sweep: number; q: number };
}

/** One recording inside a layered drum. */
export interface Layer {
  id:     string;
  gain:   number;
  rate?:  number;
  delay?: number; // seconds after the hit
  len?:   number; // seconds
  hp?:    number; // Hz, leaves out everything below
}

export interface LeadVoice {
  zones:  Zone[];
  cutoff: number;
  decay:  number;
  gain:   number;
  /** The 808 tail driven square and swept, for a line rather than a bass. */
  acid?:  { sweep: number; q: number };
}

export interface Kit {
  kick:   string;
  kickRoot: number;  // measured pitch of the kick's body
  kickGain: number;  // evens out how much sub each recording carries
  kickLen?: number;  // seconds, tightens a long kick
  clap:   [string, string]; // body, and a quieter layer for texture
  rim:    string;
  hatC:   [string, string]; // main hat, and a layer that comes up with velocity
  hatO:   string;
  perc:   [string, string];
  percTone: number;  // Hz, closes the metal and clicks down into the mix
  bass:   BassVoice;
  /** A real hit laid into the kick, like a door slam caught in a warehouse. */
  slam:   number;
  lead:   LeadVoice;
  /** Share of the kit level sent to hall / echo, per lane. */
  sends:  { stab: [number, number]; lead: [number, number]; perc: [number, number] };
  /** The backbeat, built from layers. */
  snare?: Layer[];
  snareGain?: number;
  tops?:  number;    // level of the hats, ride and shaker
  percLen?: number;  // seconds, chokes ringing metal
  stab?:  { open: number; rest: number }; // Hz, where its filter starts and settles
  /** The instrument the chord plays on, a key of CHORDS. */
  chord?: string;
  /** A recording chopped into short hits, when texture is the idea. */
  texture?: { id: string; rate: number; offset: number; from: number; to: number; gain: number };
  /** Level of each part, to sit the idea where it can be heard. */
  trim?:  Partial<Record<"bass" | "stab" | "lead" | "pad" | "perc", number>>;
}

export const FM: Zone[] = [
  { id: "fm_c3", root: 48 },
  { id: "fm_c4", root: 60 },
  { id: "fm_c5", root: 72 },
];

/**
 * Real instruments for the chord, three recorded notes each, roots measured rather than
 * read from file names. `gain` evens out their loudness, measured in a render through the chord filter. The organ's pipes speak slowly,
 * about 30 ms to half level, so it sits softer on the beat than the others.
 */
export const CHORDS: Record<string, { label: string; zones: Zone[]; gain: number }> = {
  chord_grand: { label: "Grand piano", gain: 1.12, zones: [{ id: "grand_c3", root: 48 }, { id: "grand_c4", root: 60 }, { id: "grand_c5", root: 72 }] },
  chord_upright: { label: "Upright piano", gain: 1.16, zones: [{ id: "upright_c4", root: 60 }, { id: "upright_c5", root: 72 }, { id: "upright_c6", root: 84 }] },
  chord_organ: { label: "Pipe organ", gain: 1.47, zones: [{ id: "organ_c4", root: 60 }, { id: "organ_c5", root: 72 }, { id: "organ_c6", root: 84 }] },
  chord_vibes: { label: "Vibraphone", gain: 1.21, zones: [{ id: "vibes_c4", root: 60 }, { id: "vibes_b4", root: 71 }, { id: "vibes_c6", root: 84 }] },
};
export const DEFAULT_CHORD = "chord_grand";
export const chordOf = (k: Pick<Kit, "chord">) => CHORDS[k.chord ?? DEFAULT_CHORD] ?? CHORDS[DEFAULT_CHORD];

/** The long 808 kick from 0.16 s, past its click and pitch drop: a plain analogue sub. */
export const SUB = { id: "kick_808_long", offset: 0.16, root: 31.4 };

/** Measured pitch of the long 808 kick behind the rumble (49.8 Hz). */
export const RUMBLE_ROOT = 31.3;

export const CLAVI: Zone[] = [
  { id: "clavi_c5", root: 72 },
  { id: "clavi_c6", root: 84 },
];

/** The measured body of the 808 tom, which the tuned tom line is played from. */
export const TOM_ROOT = 55.4;

export const KITS: Record<StyleId, Kit> = {
  driving: {
    kick: "kick_909_atk", kickRoot: 32.5, kickGain: 1, kickLen: 0.2, clap: ["clap_909", "clap_hands"], rim: "rim_909",
    hatC: ["hat_909_c", "hat_raw"], hatO: "hat_909_o", perc: ["rim_909", "perc_tap"], percTone: 6500,
    bass: { sub: 0.36, decay: 0.05, body: { id: "kick_tek", gain: 0.5, tone: 300, rate: 1.7 } },
    slam: 0.16,
    lead: { zones: FM, cutoff: 800, decay: 0.05, gain: 0.27 },
    sends: { stab: [0.26, 0.36], lead: [0.2, 0.36], perc: [0.1, 0.12] },
  },
  hypnotic: {
    kick: "kick_909_atk", kickRoot: 32.5, kickGain: 0.95, kickLen: 0.17, clap: ["clap_808", "perc_tap"], rim: "rim_808",
    hatC: ["hat_808_c", "hat_909_c"], hatO: "hat_808_o", perc: ["perc_blip", "rim_808"], percTone: 5200,
    bass: { sub: 0.22, decay: 0.045, body: { id: "perc_blip", gain: 1.1, tone: 280, rate: 0.85 } },
    slam: 0,
    lead: { zones: FM, cutoff: 750, decay: 0.05, gain: 0.28 },
    sends: { stab: [0.24, 0.36], lead: [0.16, 0.26], perc: [0.16, 0.32] },
  },
  tribal: {
    kick: "kick_909", kickRoot: 32.5, kickGain: 1, kickLen: 0.3, clap: ["clap_hands", "clap_808"], rim: "rim_808",
    hatC: ["hat_raw", "hat_808_c"], hatO: "hat_909_o", perc: ["perc_tap", "rim_909"], percTone: 3600,
    bass: { sub: 0.5, decay: 0.06, body: { id: "impact", gain: 0.85, tone: 300, rate: 1.2 } },
    slam: 0.22,
    lead: { zones: CLAVI, cutoff: 600, decay: 0.04, gain: 0.16 },
    sends: { stab: [0.36, 0.3], lead: [0.25, 0.3], perc: [0.22, 0.14] },
  },
  acid: {
    kick: "kick_909", kickRoot: 32.5, kickGain: 1, kickLen: 0.22, clap: ["clap_808", "clap_909"], rim: "rim_909",
    hatC: ["hat_909_c", "hat_808_c"], hatO: "hat_909_o", perc: ["perc_tap", "rim_909"], percTone: 4200,
    bass: { sub: 0.7, decay: 0.11, acid: { cutoff: 150, sweep: 1500, q: 8 } },
    slam: 0,
    lead: { zones: FM, cutoff: 700, decay: 0.05, gain: 0.14 },
    sends: { stab: [0.2, 0.3], lead: [0.18, 0.4], perc: [0.1, 0.16] },
  },
  dub: {
    kick: "kick_909", kickRoot: 32.5, kickGain: 0.9, kickLen: 0.22, clap: ["clap_808", "perc_tap"], rim: "rim_808",
    hatC: ["hat_808_c", "hat_raw"], hatO: "hat_808_o", perc: ["perc_tap", "perc_blip"], percTone: 3800,
    bass: { sub: 0.36, decay: 0.09, body: { id: "perc_blip", gain: 1, tone: 230, rate: 0.7 } },
    slam: 0,
    lead: { zones: FM, cutoff: 600, decay: 0.07, gain: 0.14 },
    sends: { stab: [0.28, 0.38], lead: [0.2, 0.3], perc: [0.2, 0.42] },
  },
  warehouse: {
    kick: "kick_tek", kickRoot: 40.3, kickGain: 0.7, clap: ["clap_hands", "clap_909"], rim: "rim_909",
    hatC: ["hat_raw", "hat_909_c"], hatO: "hat_909_o", perc: ["anvil", "brake_drum"], percTone: 3200,
    bass: { sub: 0.55, decay: 0.07, body: { id: "impact", gain: 0.85, tone: 340, rate: 1 } },
    slam: 0.32,
    lead: { zones: CLAVI, cutoff: 500, decay: 0.04, gain: 0.08 },
    sends: { stab: [0.5, 0.32], lead: [0.3, 0.3], perc: [0.36, 0.2] },
  },
};

/** Everything every style shares: the rooms, the sub, the transitions. */
const SHARED = [
  "ir_hall", "ir_room", SUB.id, "tom_808", "shaker", "ride_909", "vinyl", "gong", "gong_scrape", "impact", "crash_909",
  "cymbal_808_long", "fx_bed",
];

export function kitSamples(k: Kit): string[] {
  return [
    ...SHARED, ...chordOf(k).zones.map((z) => z.id), k.kick, ...k.clap, k.rim, ...k.hatC, k.hatO, ...k.perc, ...(k.bass.body ? [k.bass.body.id] : []),
    ...k.lead.zones.map((z) => z.id), ...(k.snare ?? []).map((l) => l.id), ...(k.texture ? [k.texture.id] : []),
  ];
}

/* ─────────────────────────── swaps ─────────────────────────────── */

export interface SoundChoice { id: string; label: string }

const PERC_CHOICES: SoundChoice[] = [
  { id: "perc_tap", label: "Tap" }, { id: "perc_blip", label: "Blip" }, { id: "rim_909", label: "909 rim" },
  { id: "rim_808", label: "808 rim" }, { id: "anvil", label: "Anvil" }, { id: "brake_drum", label: "Brake drum" },
  { id: "cowbell_808", label: "808 cowbell" },
];

/** The recordings each swappable sound can use instead of the family's own. */
export const SOUND_CHOICES: Record<SoundSlot, SoundChoice[]> = {
  kick: [
    { id: "kick_909", label: "909 (TR-8)" }, { id: "kick_909_atk", label: "909 attack (TR-8)" },
    { id: "kick_tek", label: "Tek" }, { id: "kick_klub", label: "Klub" },
  ],
  snare: [
    { id: "snare_909", label: "909 snare (TR-8)" }, { id: "snare_909_b", label: "909 snare, tight (TR-8)" },
    { id: "snare_808", label: "808 snare" }, { id: "snare_real", label: "Acoustic snare" },
    { id: "clap_909", label: "909 clap" }, { id: "clap_808", label: "808 clap" }, { id: "clap_hands", label: "Hand clap" },
  ],
  clap: [
    { id: "clap_909", label: "909 clap" }, { id: "clap_808", label: "808 clap" }, { id: "clap_hands", label: "Hand clap" },
    { id: "snare_909", label: "909 snare (TR-8)" }, { id: "snare_808", label: "808 snare" },
  ],
  rim: [{ id: "rim_909", label: "909 rim" }, { id: "rim_808", label: "808 rim" }, { id: "perc_tap", label: "Tap" }],
  hat: [
    { id: "hat_909_c", label: "909 closed" }, { id: "hat_808_c", label: "808 closed" },
    { id: "hat_raw", label: "Raw hat" }, { id: "shaker", label: "Shaker" },
  ],
  open: [{ id: "hat_909_o", label: "909 open" }, { id: "hat_808_o", label: "808 open" }, { id: "ride_909", label: "909 ride" }],
  perc: PERC_CHOICES,
  perc2: PERC_CHOICES,
  chord: Object.entries(CHORDS).map(([id, c]) => ({ id, label: c.label })),
};

/** Measured body pitch of each kick, so a swapped one is still tuned to the key. */
const KICK_ROOTS: Record<string, number> = { kick_909: 32.5, kick_909_atk: 32.5, kick_tek: 40.3, kick_klub: 32, kick_808_long: 31.4 };
/** Pitches measured from the producer's own kicks when they were added. */
export const ownKickRoots = new Map<string, number>();

export const isOwnSound = (id: string) => id.startsWith("user:");

/** A kit with the producer's swaps in place. Swapping the snare replaces its layers with one hit. */
export function withSounds(kit: Kit, sounds: Partial<Record<SoundSlot, string>> = {}): Kit {
  const out: Kit = { ...kit };
  const { kick, snare, clap, rim, hat, open, perc, perc2, chord } = sounds;
  if (kick) {
    out.kick = kick;
    out.kickRoot = KICK_ROOTS[kick] ?? ownKickRoots.get(kick) ?? kit.kickRoot;
    out.kickGain = kick === "kick_tek" ? 0.7 : 1;
    // a kick of the producer's own plays whole; theirs is already the length they want
    if (isOwnSound(kick)) out.kickLen = undefined;
  }
  if (snare) { out.snare = [{ id: snare, gain: 0.95 }]; out.snareGain = 1.2; }
  if (clap) out.clap = [clap, kit.clap[1]];
  if (rim) out.rim = rim;
  if (hat) out.hatC = [hat, kit.hatC[1]];
  if (open) out.hatO = open;
  if (perc || perc2) out.perc = [perc ?? kit.perc[0], perc2 ?? kit.perc[1]];
  if (chord && CHORDS[chord]) out.chord = chord;
  return out;
}

/** Closest zone to a pitch, plus the playback rate that lands on it. */
export function pickZone(zones: Zone[], pitch: number): { id: string; rate: number } {
  let best = zones[0];
  for (const z of zones) if (Math.abs(z.root - pitch) < Math.abs(best.root - pitch)) best = z;
  return { id: best.id, rate: 2 ** ((pitch - best.root) / 12) };
}

/** Everything a track plays, including the sounds it changes to at the end. */
export function trackSamples(track: Pick<Track, "kit" | "endKit">): string[] {
  return [...kitSamples(track.kit), ...(track.endKit ? kitSamples(track.endKit.kit) : [])];
}
