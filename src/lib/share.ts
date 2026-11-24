/**
 * lib/share.ts
 *
 * Encode/decode a whole track in the URL query string, so it is shareable as a
 * permalink with zero backend. A link carries the controls, the take seed, any
 * re-rolled lanes, held riff notes and piano-roll edits, so it reopens the exact
 * track rather than a similar one.
 */

import type { ChannelId, GeneratorConfig, Lane, ModeChoice, NoteEdit, SoundSlot, StyleId } from "../types";
import { LANES } from "../types";
import { isOwnSound, SOUND_CHOICES } from "./audio/kits";
import { familyById } from "./groove/families";

const STYLES: StyleId[] = ["driving", "hypnotic", "acid", "tribal", "dub", "warehouse", "hard"];
const RENAMED: Record<string, StyleId> = { melodic: "tribal" }; // links made before the dark groove rebuild
const MAX_EDITS = 1000;
const MAX_STEP = 272 * 16; // the DJ version's length: 208 bars and 32 of drums at each end
const RIFF_STEPS = 32;
const MAX_TOKEN = 63;
const MODES: ModeChoice[] = ["auto", "minor", "major"];
const LANE_CODES: Record<Lane, string> = { lead: "l", pad: "p", stab: "s", bass: "b", perc: "c", drums: "d" };
const CODE_LANES = Object.fromEntries(Object.entries(LANE_CODES).map(([k, v]) => [v, k])) as Record<string, Lane>;
const CHANNEL_CODES: Record<ChannelId, string> = { ...LANE_CODES, rumble: "r", fx: "x" };
const CODE_CHANNELS = Object.fromEntries(Object.entries(CHANNEL_CODES).map(([k, v]) => [v, k])) as Record<string, ChannelId>;
const SLOT_CODES: Record<SoundSlot, string> = { kick: "k", snare: "s", clap: "c", rim: "r", hat: "h", open: "o", perc: "p", perc2: "q", chord: "m" };
const CODE_SLOTS = Object.fromEntries(Object.entries(SLOT_CODES).map(([k, v]) => [v, k])) as Record<string, SoundSlot>;
const OWN_ID = /^user:[0-9a-f]{16}$/;
/** How far a fader goes, in dB. */
export const LEVEL_RANGE = [-24, 6] as const;

/**
 * `own: false` leaves out the producer's own sounds, which live only on their
 * device: a link that named them would open to stand-ins elsewhere.
 */
export function encodeConfig(cfg: GeneratorConfig, edits: NoteEdit[] = [], { own = true } = {}): string {
  const p = new URLSearchParams();
  p.set("s", cfg.style);
  p.set("b", String(cfg.bars));
  p.set("t", String(cfg.tempo));
  p.set("e", cfg.energy.toFixed(2));
  p.set("v", cfg.valence.toFixed(2));
  p.set("d", cfg.density.toFixed(2));
  p.set("x", cfg.variation.toFixed(2));
  p.set("k", String(cfg.rootPitch));
  p.set("r", String(cfg.seed));
  if (cfg.family) p.set("f", cfg.family);
  if (cfg.mode !== "auto") p.set("m", cfg.mode);
  if (cfg.dj) p.set("j", "1");
  const lanes = LANES.filter((l) => cfg.laneSeeds[l]).map((l) => `${LANE_CODES[l]}${cfg.laneSeeds[l]}`);
  if (lanes.length) p.set("l", lanes.join("."));
  const pins = Object.entries(cfg.pins).map(([step, tok]) => `${step}:${tok}`);
  if (pins.length) p.set("p", pins.join("."));
  const levels = Object.entries(cfg.levels ?? {}).filter(([, db]) => db).map(([id, db]) => `${CHANNEL_CODES[id as ChannelId]}${Number(db!.toFixed(1))}`);
  if (levels.length) p.set("g", levels.join("_"));
  const sounds = Object.entries(cfg.sounds ?? {})
    .filter(([, id]) => id && (own || !isOwnSound(id)))
    .map(([slot, id]) => `${SLOT_CODES[slot as SoundSlot]}${id}`);
  if (sounds.length) p.set("o", sounds.join("."));
  if (edits.length) p.set("n", edits.map(encodeEdit).join("."));
  return p.toString();
}

function encodeEdit(e: NoteEdit): string {
  return `${e.op === "add" ? "a" : "r"}${LANE_CODES[e.lane]}${e.step}:${e.pitch}${e.root == null ? "" : `_${e.root}`}`;
}

function decodeEdit(text: string): NoteEdit | null {
  const m = /^([ar])([lpsbcd])(\d+):(\d+)(?:_(\d+))?$/.exec(text);
  if (!m) return null;
  const pitch = Number(m[4]);
  if (pitch > 127 || Number(m[3]) >= MAX_STEP) return null;
  const edit: NoteEdit = { op: m[1] === "a" ? "add" : "remove", lane: CODE_LANES[m[2]], step: Number(m[3]), pitch };
  if (m[5] != null && Number(m[5]) < 12) edit.root = Number(m[5]);
  return edit;
}

export function shareURL(cfg: GeneratorConfig, edits: NoteEdit[] = []): string {
  const url = new URL(window.location.href);
  url.search = encodeConfig(cfg, edits, { own: false });
  url.hash = "";
  return url.toString();
}

/** Parse a partial config from a query string (defaults to the current URL). */
export function parseConfigFromURL(search?: string): { config: Partial<GeneratorConfig>; edits: NoteEdit[] } {
  const q = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const p = new URLSearchParams(q);
  const out: Partial<GeneratorConfig> = {};

  const s = styleOf(p.get("s"));
  if (s) out.style = s;
  const family = familyById(p.get("f"));
  if (family) out.family = family.id;
  if (p.get("j") === "1") out.dj = true;
  const m = p.get("m");
  if (m && MODES.includes(m as ModeChoice)) out.mode = m as ModeChoice;

  const int = (k: string, lo: number, hi: number) => {
    const v = p.get(k);
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
  };
  const flt = (k: string) => {
    const v = p.get(k);
    if (v == null) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
  };

  const b = int("b", 16, 208); if (b != null) out.bars = b;
  const t = int("t", 90, 175); if (t != null) out.tempo = t;
  const k = int("k", 0, 11); if (k != null) out.rootPitch = k;
  const r = int("r", 1, 0x7fffffff); if (r != null) out.seed = r;
  const e = flt("e"); if (e != null) out.energy = e;
  const v = flt("v"); if (v != null) out.valence = v;
  const d = flt("d"); if (d != null) out.density = d;
  const x = flt("x"); if (x != null) out.variation = x;

  const lanes = p.get("l");
  if (lanes) {
    const seeds: Partial<Record<Lane, number>> = {};
    for (const item of lanes.split(".")) {
      const lane = CODE_LANES[item[0]];
      const n = parseInt(item.slice(1), 10);
      if (lane && Number.isSafeInteger(n) && n >= 0) seeds[lane] = n;
    }
    out.laneSeeds = seeds;
  }
  const pins = p.get("p");
  if (pins) {
    const held: Record<number, number> = {};
    for (const item of pins.split(".")) {
      const [step, tok] = item.split(":").map(Number);
      if (Number.isInteger(step) && Number.isInteger(tok) && step >= 0 && step < RIFF_STEPS && tok >= 0 && tok <= MAX_TOKEN) held[step] = tok;
    }
    out.pins = held;
  }

  const levels = p.get("g");
  if (levels) {
    const set: Partial<Record<ChannelId, number>> = {};
    for (const item of levels.split("_")) {
      const id = CODE_CHANNELS[item[0]];
      const db = parseFloat(item.slice(1));
      if (id && Number.isFinite(db)) set[id] = Math.max(LEVEL_RANGE[0], Math.min(LEVEL_RANGE[1], Math.round(db * 10) / 10));
    }
    out.levels = set;
  }

  const sounds = p.get("o");
  if (sounds) {
    const set: Partial<Record<SoundSlot, string>> = {};
    for (const item of sounds.split(".")) {
      const slot = CODE_SLOTS[item[0]];
      const id = item.slice(1);
      if (slot && (OWN_ID.test(id) || SOUND_CHOICES[slot].some((c) => c.id === id))) set[slot] = id;
    }
    out.sounds = set;
  }

  const notes = p.get("n");
  const edits = notes ? notes.split(".", MAX_EDITS).map(decodeEdit).filter((e): e is NoteEdit => e !== null) : [];
  return { config: out, edits };
}

/* ── persist the last-used config between visits (localStorage) ──────── */

const LS_KEY = "soundxai.config.v3";

function styleOf(value: unknown): StyleId | undefined {
  if (typeof value !== "string") return undefined;
  if (Object.hasOwn(RENAMED, value)) return RENAMED[value];
  return STYLES.includes(value as StyleId) ? (value as StyleId) : undefined;
}

/** Saved settings are outside input too: keep only fields with usable values. */
export function cleanControls(raw: unknown): Partial<GeneratorConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<GeneratorConfig> = {};
  const style = styleOf(r.style);
  if (style) out.style = style;
  if (MODES.includes(r.mode as ModeChoice)) out.mode = r.mode as ModeChoice;
  const num = (key: "bars" | "tempo" | "rootPitch" | "energy" | "valence" | "density" | "variation", lo: number, hi: number, whole = false) => {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return;
    out[key] = whole ? Math.round(v) : v;
  };
  num("bars", 16, 208, true);
  num("tempo", 90, 175, true);
  num("rootPitch", 0, 11, true);
  for (const key of ["energy", "valence", "density", "variation"] as const) num(key, 0, 1);
  return out;
}

/** Settings saved by versions from before sessions were kept whole. */
export function loadSavedConfig(): Partial<GeneratorConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? cleanControls(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}
