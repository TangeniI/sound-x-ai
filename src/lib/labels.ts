/** Names the interface uses, kept in one place so every view agrees. */

import type { Lane, SectionKind, StyleId, Track } from "../types";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * `store` is the shelf a store files the style on. Beatport splits techno in two:
 * Peak Time / Driving, and Raw / Deep / Hypnotic. Files carry it as their genre.
 */
export const STYLES: { id: StyleId; label: string; desc: string; store: string; tempo?: number; rootPitch?: number }[] = [
  { id: "driving", label: "Groove", desc: "Twelve families, one idea each", store: "Peak Time / Driving" },
  { id: "hypnotic", label: "Hypnotic", desc: "Turning loops, long echoes", store: "Raw / Deep / Hypnotic" },
  { id: "tribal", label: "Percussive", desc: "Tuned toms, taps and hand claps", store: "Peak Time / Driving" },
  { id: "warehouse", label: "Raw", desc: "Anvil, brake drum, rumble", store: "Raw / Deep / Hypnotic" },
  { id: "dub", label: "Dub", desc: "One chord, tape and space", store: "Raw / Deep / Hypnotic" },
  { id: "acid", label: "Acid", desc: "Accent, slide, resonance", store: "Peak Time / Driving" },
  { id: "hard", label: "Hard", desc: "Driven kick, 156 BPM, loud", store: "Hard Techno", tempo: 156 },
  // most of the SoundCloud edits it was measured on sit at 150-155 BPM, around D# minor / F# major
  { id: "bounce", label: "Bounce", desc: "Offbeat bass, chords and a hook up front", store: "Hard Techno", tempo: 152, rootPitch: 3 },
];

/** The genre a store would file a track under, as written in its tags. */
export function storeGenre(style: StyleId): string {
  const shelf = STYLES.find((s) => s.id === style)?.store;
  // Hard Techno is a genre of its own on Beatport, not a shelf of Techno
  return !shelf ? "Techno" : shelf === "Hard Techno" ? shelf : `Techno (${shelf})`;
}

// the engine's section kinds predate the dark groove rebuild; these are the words for them
export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: "Intro", groove: "Groove", riff: "Develop", break: "Break", build: "Lift", drop: "Peak", outro: "Outro",
};

export const LANE_LABEL: Record<Lane, string> = {
  lead: "Sequence", pad: "Atmos", stab: "Chord", bass: "Bass", perc: "Perc", drums: "Drums",
};

export const LANE_COLOR: Record<Lane, string> = {
  lead: "#eee9df", pad: "#7f8c97", stab: "#c4a57e", bass: "#ff5c35", perc: "#a9a39a", drums: "#d5cfc4",
};

const SCALE_NAMES: Record<string, string> = {
  "0,1,3,5,7,8,10": "Phrygian", "0,2,3,5,7,8,10": "minor", "0,2,3,5,7,9,10": "Dorian", "0,2,4,5,7,9,11": "major",
};

export function keyName(track: Track): string {
  return `${NOTE_NAMES[track.root]} ${SCALE_NAMES[track.scale.join(",")] ?? track.tonality}`;
}

export function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
