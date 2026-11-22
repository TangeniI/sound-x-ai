/** Names the interface uses, kept in one place so every view agrees. */

import type { Lane, SectionKind, StyleId, Track } from "../types";

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const STYLES: { id: StyleId; label: string; desc: string }[] = [
  { id: "driving", label: "Groove", desc: "Twelve families, one idea each" },
  { id: "hypnotic", label: "Hypnotic", desc: "Turning loops, long echoes" },
  { id: "tribal", label: "Percussive", desc: "Tuned toms, taps and hand claps" },
  { id: "warehouse", label: "Raw", desc: "Anvil, brake drum, rumble" },
  { id: "dub", label: "Dub", desc: "One chord, tape and space" },
  { id: "acid", label: "Acid", desc: "Accent, slide, resonance" },
];

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
