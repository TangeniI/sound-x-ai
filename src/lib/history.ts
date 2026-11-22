/**
 * lib/history.ts
 *
 * Undo, redo and the list of takes, kept between visits. A change after an undo
 * clears redo, but what was undone moves into undo rather than being dropped,
 * and the takes it left keep their edits. So one key press can't lose a track.
 */

import type { GeneratorConfig, NoteEdit } from "../types";
import { encodeConfig, parseConfigFromURL } from "./share";

export interface Snapshot { config: GeneratorConfig; edits: NoteEdit[] }

export interface History {
  past:   Snapshot[];
  now:    Snapshot;
  future: Snapshot[];
  /** The last state of each take, newest first. */
  takes:  Snapshot[];
  /** What the last change was, so one drag of a slider is one undo. */
  last?:  { tag: string; at: number };
}

const MAX_STEPS = 80;
const MAX_TAKES = 30;
const SAME_GESTURE_MS = 700;
const KEY = "soundxai.session.v4";

function remember(takes: Snapshot[], snap: Snapshot): Snapshot[] {
  return [snap, ...takes.filter((t) => t.config.seed !== snap.config.seed)].slice(0, MAX_TAKES);
}

export function startHistory(now: Snapshot): History {
  return { past: [], now, future: [], takes: [now] };
}

/** Record a change. Changes with the same tag in quick succession are one step. */
export function commit(h: History, next: Snapshot, tag = "", at = Date.now()): History {
  const same = tag !== "" && h.last?.tag === tag && at - h.last.at < SAME_GESTURE_MS;
  // what was undone comes after where it was undone to, so undo can reach it
  const undone = h.future.length ? [h.now, ...h.future] : [];
  return {
    past: same ? h.past : [...h.past, ...undone, h.now].slice(-MAX_STEPS),
    now: next,
    future: [],
    takes: [...undone.slice(1), h.now, next].reduce(remember, h.takes),
    last: { tag, at },
  };
}

export function undo(h: History): History {
  const now = h.past[h.past.length - 1];
  if (!now) return h;
  return { past: h.past.slice(0, -1), now, future: [h.now, ...h.future], takes: remember(h.takes, now) };
}

export function redo(h: History): History {
  const now = h.future[0];
  if (!now) return h;
  return { past: [...h.past, h.now], now, future: h.future.slice(1), takes: remember(h.takes, now) };
}

/* ── between visits: every snapshot is stored as its share link ─────── */

const write = (s: Snapshot) => encodeConfig(s.config, s.edits);

function read(text: unknown, base: GeneratorConfig): Snapshot | null {
  if (typeof text !== "string") return null;
  const { config, edits } = parseConfigFromURL(text);
  if (config.seed == null || !config.style) return null;
  return { config: { ...base, laneSeeds: {}, pins: {}, ...config }, edits };
}

export function serialise(h: History): string {
  return JSON.stringify({ past: h.past.map(write), now: write(h.now), future: h.future.map(write), takes: h.takes.map(write) });
}

export function deserialise(text: string | null, base: GeneratorConfig): History | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    const now = read(raw?.now, base);
    if (!now) return null;
    const list = (value: unknown, max: number) =>
      (Array.isArray(value) ? value : []).slice(0, max).map((v) => read(v, base)).filter((s): s is Snapshot => s !== null);
    return { past: list(raw.past, MAX_STEPS), now, future: list(raw.future, MAX_STEPS), takes: remember(list(raw.takes, MAX_TAKES), now) };
  } catch {
    return null;
  }
}

export function loadHistory(base: GeneratorConfig): History | null {
  try {
    return deserialise(localStorage.getItem(KEY), base);
  } catch {
    return null;
  }
}

export function saveHistory(h: History): void {
  try {
    // another open tab has takes of its own: keep those too
    const stored = deserialise(localStorage.getItem(KEY), h.now.config);
    const takes = [...h.takes];
    for (const t of stored?.takes ?? []) if (!takes.some((x) => x.config.seed === t.config.seed)) takes.push(t);
    localStorage.setItem(KEY, serialise({ ...h, takes: takes.slice(0, MAX_TAKES) }));
  } catch {
    /* storage is full or blocked: the session still works */
  }
}
