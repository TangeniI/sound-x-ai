/**
 * lib/share.ts
 *
 * Encode/decode a whole track in the URL query string, so it is shareable as a
 * permalink with zero backend. A link carries the controls, the take seed, any
 * re-rolled lanes, held riff notes and piano-roll edits, so it reopens the exact
 * track rather than a similar one.
 */

import type { GeneratorConfig, Lane, ModeChoice, NoteEdit, StyleId } from "../types";
import { LANES } from "../types";

const STYLES: StyleId[] = ["driving", "hypnotic", "acid", "melodic", "dub", "warehouse"];
const MODES: ModeChoice[] = ["auto", "minor", "major"];
const LANE_CODES: Record<Lane, string> = { lead: "l", pad: "p", stab: "s", bass: "b", perc: "c", drums: "d" };
const CODE_LANES = Object.fromEntries(Object.entries(LANE_CODES).map(([k, v]) => [v, k])) as Record<string, Lane>;

export function encodeConfig(cfg: GeneratorConfig, edits: NoteEdit[] = []): string {
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
  if (cfg.mode !== "auto") p.set("m", cfg.mode);
  const lanes = LANES.filter((l) => cfg.laneSeeds[l]).map((l) => `${LANE_CODES[l]}${cfg.laneSeeds[l]}`);
  if (lanes.length) p.set("l", lanes.join("."));
  const pins = Object.entries(cfg.pins).map(([step, tok]) => `${step}:${tok}`);
  if (pins.length) p.set("p", pins.join("."));
  if (edits.length) p.set("n", edits.map(encodeEdit).join("."));
  return p.toString();
}

function encodeEdit(e: NoteEdit): string {
  return `${e.op === "add" ? "a" : "r"}${LANE_CODES[e.lane]}${e.step}:${e.pitch}`;
}

function decodeEdit(text: string): NoteEdit | null {
  const m = /^([ar])([lpsbcd])(\d+):(\d+)$/.exec(text);
  if (!m) return null;
  const pitch = Number(m[4]);
  if (pitch > 127) return null;
  return { op: m[1] === "a" ? "add" : "remove", lane: CODE_LANES[m[2]], step: Number(m[3]), pitch };
}

export function shareURL(cfg: GeneratorConfig, edits: NoteEdit[] = []): string {
  const url = new URL(window.location.href);
  url.search = encodeConfig(cfg, edits);
  url.hash = "";
  return url.toString();
}

/** Parse a partial config from a query string (defaults to the current URL). */
export function parseConfigFromURL(search?: string): { config: Partial<GeneratorConfig>; edits: NoteEdit[] } {
  const q = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const p = new URLSearchParams(q);
  const out: Partial<GeneratorConfig> = {};

  const s = p.get("s");
  if (s && STYLES.includes(s as StyleId)) out.style = s as StyleId;
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

  const b = int("b", 16, 128); if (b != null) out.bars = b;
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
      if (lane && Number.isFinite(n)) seeds[lane] = n;
    }
    out.laneSeeds = seeds;
  }
  const pins = p.get("p");
  if (pins) {
    const held: Record<number, number> = {};
    for (const item of pins.split(".")) {
      const [step, tok] = item.split(":").map(Number);
      if (Number.isInteger(step) && Number.isInteger(tok) && step >= 0 && step < 32) held[step] = tok;
    }
    out.pins = held;
  }

  const notes = p.get("n");
  const edits = notes ? notes.split(".").map(decodeEdit).filter((e): e is NoteEdit => e !== null) : [];
  return { config: out, edits };
}

/* ── persist the last-used config between visits (localStorage) ──────── */

const LS_KEY = "soundxai.config.v2";

export function saveConfig(cfg: Partial<GeneratorConfig>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export function loadSavedConfig(): Partial<GeneratorConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<GeneratorConfig>) : {};
  } catch {
    return {};
  }
}
