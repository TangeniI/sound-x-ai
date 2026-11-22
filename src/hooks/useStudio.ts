/**
 * hooks/useStudio.ts
 *
 * The studio's state and actions in one place: controls, the current track,
 * edits, transport, mixer and export. Components stay presentational, and read
 * the playhead straight from the audio clock rather than through React state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { analyseAudioFile } from "../lib/audio-analysis";
import { player } from "../lib/audio/player";
import { download, encodeMidi, encodeWav, renderLoop, renderTrack, stemsZip, type Range } from "../lib/audio/render";
import { sliceTrack } from "../lib/audio/slice";
import type { ChannelId } from "../lib/audio/graph";
import { DEFAULT_CONFIG, editPitch, generativeEngine, LENGTHS, newSeed } from "../lib/generative-engine";
import { FAMILIES } from "../lib/groove/families";
import { loopBars } from "../lib/groove/flow";
import { commit, loadHistory, redo, saveHistory, startHistory, undo, type History, type Snapshot } from "../lib/history";
import { NOTE_NAMES } from "../lib/labels";
import { neuralRiff } from "../lib/neural-engine";
import { sampleBank } from "../lib/audio/samples";
import { loadSavedConfig, parseConfigFromURL, shareURL } from "../lib/share";
import { LANES, type AudioFeatures, type GeneratorConfig, type Lane, type NoteEdit, type Track } from "../types";

export type LoopMode = "four" | "eight" | "sixteen" | "track" | "section" | "off";
export const LOOP_BARS: Partial<Record<LoopMode, number>> = { four: 4, eight: 8, sixteen: 16 };
const inBars = (mode: LoopMode) => LOOP_BARS[mode] != null;

/** A loop of whole bars from the peak, where a new Groove opens. */
function peakBars(track: Track, bars: number): Range {
  const total = track.sections.reduce((n, s) => n + s.bars, 0);
  const start = Math.min(loopBars(track.sections).start, Math.max(0, total - bars));
  return { startBar: start, bars: Math.min(bars, total - start) };
}

function seconds(track: Track, r: Range) {
  const barSec = track.stepSec * 16;
  return { start: r.startBar * barSec, end: (r.startBar + r.bars) * barSec };
}

export interface ExportFormat { bits: 16 | 24; rate: 44100 | 48000 }
const FORMAT_KEY = "soundxai.export.v1";
function loadFormat(): ExportFormat {
  try {
    const raw = JSON.parse(localStorage.getItem(FORMAT_KEY) ?? "{}");
    return { bits: raw.bits === 16 ? 16 : 24, rate: raw.rate === 44100 ? 44100 : 48000 };
  } catch {
    return { bits: 24, rate: 48000 };
  }
}

/** The bars where a lane plays exactly what it plays in `bar`. */
function repeatsOf(track: Track, lane: Lane, bar: number): number[] {
  const total = track.sections.reduce((n, s) => n + s.bars, 0);
  const content = (b: number) => track.notes
    .filter((n) => n.instrument === lane && n.step >= b * 16 && n.step < b * 16 + 16)
    .map((n) => `${n.step - b * 16}:${n.pitch}`).sort().join();
  const own = content(bar);
  return Array.from({ length: total }, (_, b) => b).filter((b) => content(b) === own);
}

const SHARED_NOTICE = "Shared track loaded. Press play.";
/** The share notice is done once the track plays; any other message stays. */
const withoutNotice = (status: string) => (status === SHARED_NOTICE ? "" : status);

function initialState(): { history: History; fromLink: boolean } {
  const { config: linked, edits } = parseConfigFromURL();
  const fromLink = Object.keys(linked).length > 0;
  const saved = loadHistory(DEFAULT_CONFIG);
  const tidy = (c: GeneratorConfig) => (LENGTHS.includes(c.bars) ? c : { ...c, bars: DEFAULT_CONFIG.bars });
  if (fromLink) {
    const now = { config: tidy({ ...DEFAULT_CONFIG, ...linked }), edits };
    // opening a link is a change like any other, so it can be undone
    return { history: saved ? commit(saved, now) : startHistory(now), fromLink };
  }
  if (saved) return { history: { ...saved, now: { ...saved.now, config: tidy(saved.now.config) } }, fromLink };
  return { history: startHistory({ config: tidy({ ...DEFAULT_CONFIG, ...loadSavedConfig() }), edits: [] }), fromLink };
}

export function trackFileName(track: Track): string {
  const { style, tempo, seed } = track.config;
  const name = track.family ? `groove-${track.family.id}` : style;
  return `sound-x-ai-${name}-${NOTE_NAMES[track.root].replace("#", "s")}-${tempo}bpm-${seed}`;
}

export function useStudio() {
  const [{ history: firstHistory, fromLink }] = useState(initialState);
  const [history, setHistory] = useState(firstHistory);
  const { config, edits } = history.now;
  const [track, setTrack] = useState<Track | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState(fromLink ? SHARED_NOTICE : "");
  const [busy, setBusy] = useState(false);
  // a shared track plays as sent, anything else in Groove starts on its best eight bars
  const [loop, setLoop] = useState<LoopMode>(!fromLink && config.style === "driving" ? "eight" : "track");
  const loopRef = useRef(loop);
  const [muted, setMuted] = useState<Set<ChannelId>>(new Set());
  const [soloed, setSoloed] = useState<Set<ChannelId>>(new Set());
  const [source, setSource] = useState<AudioFeatures | null>(null);
  const [copied, setCopied] = useState(false);
  const [locks, setLocks] = useState<Set<Lane>>(new Set());
  const [format, setFormatState] = useState<ExportFormat>(loadFormat);

  const ticket = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trackRef = useRef<Track | null>(null);
  const [seeks, setSeeks] = useState(0);
  const latest = useRef(history);

  /** Write the track for a config and hand it to the player. */
  const rebuild = useCallback(async (cfg: GeneratorConfig, ed: NoteEdit[], from?: number) => {
    const mine = ++ticket.current;
    try {
      const next = generativeEngine.generate(cfg, ed);
      if (!trackRef.current) setLoadProgress(0);
      await player.prepare(next, (p) => {
        if (!trackRef.current) setLoadProgress(p);
      });
      if (mine !== ticket.current) return;
      trackRef.current = next;
      player.setTrack(next);
      // another take can have its peak in another place
      const size = LOOP_BARS[loopRef.current];
      if (size) {
        const range = seconds(next, peakBars(next, size));
        player.setRange(range);
        const at = player.position();
        if (!player.playing && from == null && (at < range.start || at >= range.end)) player.seek(range.start);
        setSeeks((n) => n + 1);
      }
      setTrack(next);
      setReady(true);
      const missing = sampleBank.failed.size;
      if (missing) setStatus(`${missing} recording${missing > 1 ? "s" : ""} failed to load. Reload for the full sound.`);
      if (from != null) {
        await player.play(from);
        setPlaying(true);
        setStatus(withoutNotice);
      }
    } catch (e) {
      setStatus(`Couldn't build the track: ${(e as Error).message}`);
    }
  }, []);

  // first load: fetch the model, then write the first track
  useEffect(() => {
    let live = true;
    void neuralRiff.load().then(() => { if (live) void rebuild(latest.current.now.config, latest.current.now.edits); });
    player.onEnd = () => setPlaying(false);
    return () => { live = false; };
  }, [rebuild]);

  useEffect(() => {
    saveHistory(history);
    // the session holds the track from here. A link left in the address bar would undo your work on reload.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [history]);

  const show = useCallback((next: History) => {
    latest.current = next;
    setHistory(next);
  }, []);

  /** Every change goes through here, so every change can be undone. */
  const change = useCallback((next: Snapshot, tag = "") => show(commit(latest.current, next, tag)), [show]);

  /** Change controls. The take stays the same, and the music updates as you move. */
  const update = useCallback((patch: Partial<GeneratorConfig>) => {
    const { now } = latest.current;
    change({ config: { ...now.config, ...patch }, edits: now.edits }, Object.keys(patch).join());
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void rebuild(latest.current.now.config, latest.current.now.edits), 90);
  }, [change, rebuild]);

  /** Go to a saved state. */
  const travel = useCallback((next: History, what: string) => {
    if (next === latest.current) return;
    show(next);
    clearTimeout(timer.current);
    setStatus(what);
    void rebuild(next.now.config, next.now.edits);
  }, [show, rebuild]);

  const undoChange = useCallback(() => travel(undo(latest.current), "Undone"), [travel]);
  const redoChange = useCallback(() => travel(redo(latest.current), "Redone"), [travel]);
  const openTake = useCallback((take: Snapshot) => {
    travel(commit(latest.current, take), `Back to take #${take.config.seed}`);
  }, [travel]);

  const togglePlay = useCallback(async () => {
    player.unlock();
    if (player.playing) {
      player.stop();
      setPlaying(false);
      return;
    }
    await player.play(player.position());
    setPlaying(true);
    setStatus(withoutNotice);
  }, []);

  /** Present lanes that aren't locked, which a new take or Randomise rewrites. */
  const unlockedLanes = useCallback(() => {
    const present = new Set(trackRef.current?.notes.map((n) => n.instrument));
    return LANES.filter((l) => present.has(l) && !locks.has(l));
  }, [locks]);

  /** With parts locked, a new take rewrites only the others, and keeps the groove they sit in. */
  const rewriteUnlocked = useCallback(async () => {
    const lanes = unlockedLanes();
    const laneSeeds = { ...config.laneSeeds };
    for (const l of lanes) laneSeeds[l] = (laneSeeds[l] ?? 0) + 1;
    const next = { ...config, laneSeeds };
    const nextEdits = edits.filter((e) => !lanes.includes(e.lane));
    change({ config: next, edits: nextEdits });
    setStatus(lanes.length ? `Rewrote ${lanes.length} unlocked part${lanes.length > 1 ? "s" : ""}` : "Every part is locked");
    await rebuild(next, nextEdits, player.playing ? player.position() : undefined);
  }, [config, edits, change, rebuild, unlockedLanes]);

  /** A new take of the current style and controls. */
  const newTake = useCallback(async () => {
    player.unlock();
    if (locks.size) return rewriteUnlocked();
    // a Groove stays in its family: Randomise is what changes the idea
    const family = config.style === "driving" ? trackRef.current?.family?.id ?? config.family : config.family;
    const next = { ...config, family, seed: newSeed(), laneSeeds: {}, pins: {} };
    change({ config: next, edits: [] });
    setStatus(`New take #${next.seed}`);
    await rebuild(next, [], 0);
  }, [config, change, rebuild, locks, rewriteUnlocked]);

  /**
   * Randomise is Groove only until the other styles have had the same work. It
   * picks a family, then varies it inside the limits that family was written for.
   * With parts locked it keeps the family, and rewrites the rest.
   */
  const randomise = useCallback(async () => {
    player.unlock();
    if (locks.size) return rewriteUnlocked();
    const others = FAMILIES.filter((f) => f.id !== trackRef.current?.family?.id);
    const family = others[Math.floor(Math.random() * others.length)];
    const rnd = (lo: number, hi: number) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
    const next: GeneratorConfig = {
      ...config,
      style: "driving",
      family: family.id,
      tempo: family.tempo[0] + Math.floor(Math.random() * (family.tempo[1] - family.tempo[0] + 1)),
      energy: rnd(0.62, 0.85),
      valence: rnd(0.12, 0.45),
      density: rnd(0.5, 0.8),
      variation: rnd(0.25, 0.55),
      rootPitch: family.keys[Math.floor(Math.random() * family.keys.length)],
      mode: "auto",
      seed: newSeed(),
      laneSeeds: {},
      pins: {},
    };
    change({ config: next, edits: [] });
    setStatus(`${family.name} in ${NOTE_NAMES[next.rootPitch]} at ${next.tempo} BPM`);
    if (!inBars(loopRef.current)) {
      loopRef.current = "eight";
      setLoop("eight");
    }
    player.loop = true;
    await rebuild(next, [], 0);
  }, [config, change, rebuild, locks, rewriteUnlocked]);

  const toggleLock = useCallback((lane: Lane) => {
    setLocks((now) => {
      const next = new Set(now);
      if (next.has(lane)) next.delete(lane); else next.add(lane);
      return next;
    });
  }, []);

  /** Rewrite one lane and keep the rest of the track. */
  const rerollLane = useCallback((lane: Lane) => {
    const nextEdits = edits.filter((e) => e.lane !== lane);
    const next = { ...config, laneSeeds: { ...config.laneSeeds, [lane]: (config.laneSeeds[lane] ?? 0) + 1 } };
    change({ config: next, edits: nextEdits });
    void rebuild(next, nextEdits);
  }, [config, edits, change, rebuild]);

  /**
   * Add or remove a note in every bar where that part plays the same as this one,
   * so a pattern changes everywhere it repeats. `oneBar` changes this bar only.
   */
  const toggleNote = useCallback((lane: Lane, step: number, pitch: number, oneBar = false) => {
    const t = trackRef.current;
    if (!t) return;
    const exists = t.notes.some((n) => n.instrument === lane && n.step === step && n.pitch === pitch);
    const root = config.rootPitch;
    const within = step % 16;
    const bars = oneBar ? [Math.floor(step / 16)] : repeatsOf(t, lane, Math.floor(step / 16));
    let nextEdits = edits;
    for (const bar of bars) {
      const at = bar * 16 + within;
      // clicking a note you added takes it away; clicking where you deleted one restores it
      const op = exists ? "add" : "remove";
      const own = nextEdits.findIndex((e) => e.op === op && e.lane === lane && e.step === at && editPitch(e, root) === pitch);
      nextEdits = own >= 0
        ? nextEdits.filter((_, i) => i !== own)
        : [...nextEdits, { op: exists ? "remove" : "add", lane, step: at, pitch, root }];
    }
    change({ config, edits: nextEdits });
    if (bars.length > 1) setStatus(`Changed in ${bars.length} bars. Shift-click changes one bar.`);
    const next = generativeEngine.generate(config, nextEdits);
    trackRef.current = next;
    setTrack(next);
    player.updateNotes(next.notes);
  }, [config, edits, change]);

  /** Hold (or release) a note in the riff. The model continues from it. */
  const pinRiff = useCallback((step: number, token: number) => {
    const pins = { ...config.pins };
    if (pins[step] === token) delete pins[step];
    else pins[step] = token;
    const next = { ...config, pins };
    change({ config: next, edits });
    void rebuild(next, edits);
  }, [config, edits, change, rebuild]);

  const seek = useCallback((to: number) => {
    // choosing a place outside the eight bars means you want the arrangement
    const range = player.range;
    if (inBars(loopRef.current) && range && (to < range.start || to >= range.end)) {
      player.setRange(null);
      loopRef.current = "track";
      setLoop("track");
    }
    player.seek(to);
    setSeeks((n) => n + 1);
  }, []);

  /* ─────────────────────────── looping ────────────────────────────── */

  const sectionRange = useCallback(() => {
    const t = trackRef.current;
    if (!t) return null;
    const barSec = t.stepSec * 16;
    const pos = player.position();
    const s = t.sections.find((x) => pos < (x.startBar + x.bars) * barSec) ?? t.sections[t.sections.length - 1];
    return { start: s.startBar * barSec, end: (s.startBar + s.bars) * barSec };
  }, []);

  const cycleLoop = useCallback(() => {
    const order: LoopMode[] = ["eight", "four", "sixteen", "track", "section", "off"];
    const next = order[(order.indexOf(loopRef.current) + 1) % order.length];
    const t = trackRef.current;
    const size = LOOP_BARS[next];
    player.loop = next !== "off";
    player.setRange(next === "section" ? sectionRange() : size && t ? seconds(t, peakBars(t, size)) : null);
    loopRef.current = next;
    setLoop(next);
  }, [sectionRange]);

  /** Leave the eight-bar loop and hear the arrangement from the top. */
  const playFull = useCallback(async () => {
    player.unlock();
    player.setRange(null);
    player.loop = true;
    loopRef.current = "track";
    setLoop("track");
    await player.play(0);
    setPlaying(true);
    setSeeks((n) => n + 1);
  }, []);

  /* ──────────────────────────── mixer ─────────────────────────────── */

  const toggleMute = useCallback((id: ChannelId) => {
    const next = new Set(muted);
    if (next.has(id)) next.delete(id); else next.add(id);
    player.setMute(id, next.has(id));
    setMuted(next);
  }, [muted]);

  const toggleSolo = useCallback((id: ChannelId) => {
    const next = new Set(soloed);
    if (next.has(id)) next.delete(id); else next.add(id);
    player.setSolo(id, next.has(id));
    setSoloed(next);
  }, [soloed]);

  /* ─────────────────────────── analysis ───────────────────────────── */

  /** Analysing a file fills in the controls, and they stay yours to change. */
  const analyse = useCallback(async (file: File, onStatus: (m: string) => void) => {
    const f = await analyseAudioFile(file, onStatus);
    setSource(f);
    update({
      tempo: Math.max(90, Math.min(175, f.tempo)),
      energy: Number(f.energy.toFixed(2)),
      valence: Number(f.valence.toFixed(2)),
      density: Number(f.danceability.toFixed(2)),
      rootPitch: f.rootPitch ?? config.rootPitch,
      mode: f.mode ?? "auto",
    });
    return f;
  }, [config.rootPitch, update]);

  /* ──────────────────────────── export ────────────────────────────── */

  const sampleRate = () => player.context().sampleRate;

  const setFormat = useCallback((next: ExportFormat) => {
    setFormatState(next);
    try { localStorage.setItem(FORMAT_KEY, JSON.stringify(next)); } catch { /* private window: still works this visit */ }
  }, []);

  /** The bars a loop export covers: the bar loop or section that's playing. */
  const loopRange = useCallback((): Range | null => {
    const t = trackRef.current;
    if (!t) return null;
    const size = LOOP_BARS[loopRef.current];
    if (size) return peakBars(t, size);
    if (loopRef.current === "section" && player.range) {
      const barSec = t.stepSec * 16;
      return { startBar: Math.round(player.range.start / barSec), bars: Math.round((player.range.end - player.range.start) / barSec) };
    }
    return null;
  }, []);

  /** Run an export with the busy state and a message either way. */
  const exporting = useCallback(async (label: string, work: (t: Track) => Promise<void>) => {
    const t = trackRef.current;
    if (!t) return;
    setBusy(true);
    setStatus(label);
    try {
      await work(t);
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const levels = () => latest.current.now.config.levels ?? {};
  const loopName = (t: Track, r: Range) => `${trackFileName(t)}-bars${r.startBar + 1}-${r.startBar + r.bars}`;

  const exportWav = useCallback(() => exporting("Rendering WAV", async (t) => {
    const audio = await renderTrack(t, sampleRate(), {
      audible: player.audible(), levels: levels(), rate: format.rate,
      onProgress: (p) => setStatus(`Rendering WAV ${Math.round(p * 100)}%`),
    });
    download(encodeWav(audio, format.bits), `${trackFileName(t)}.wav`);
    setStatus("WAV downloaded");
  }), [exporting, format]);

  const exportLoopWav = useCallback(() => exporting("Rendering loop", async (t) => {
    const r = loopRange();
    if (!r) return setStatus("Choose a bar or section loop first");
    const audio = await renderLoop(t, r.startBar, r.bars, sampleRate(), {
      audible: player.audible(), levels: levels(), rate: format.rate,
      onProgress: (p) => setStatus(`Rendering loop ${Math.round(p * 100)}%`),
    });
    download(encodeWav(audio, format.bits), `${loopName(t, r)}.wav`);
    setStatus(`Loop downloaded: ${r.bars} bars at ${t.bpm} BPM`);
  }), [exporting, format, loopRange]);

  const exportStems = useCallback((loopOnly: boolean) => exporting("Rendering stems", async (t) => {
    const range = loopOnly ? loopRange() : undefined;
    if (loopOnly && !range) return setStatus("Choose a bar or section loop first");
    const name = range ? loopName(t, range) : trackFileName(t);
    const zip = await stemsZip(t, sampleRate(), player.audible(), name, {
      range: range ?? undefined, bits: format.bits, rate: format.rate, levels: levels(),
      onProgress: (p, stem) => setStatus(`Rendering stems ${Math.round(p * 100)}%, ${stem}`),
    });
    download(zip, `${name}-stems.zip`);
    setStatus("Stems downloaded");
  }), [exporting, format, loopRange]);

  const exportMidi = useCallback(async (loopOnly = false) => {
    const t = trackRef.current;
    if (!t) return;
    const r = loopOnly ? loopRange() : null;
    if (loopOnly && !r) return setStatus("Choose a bar or section loop first");
    const part = r ? sliceTrack(t, r.startBar, r.bars) : t;
    download(await encodeMidi(part, player.audible()), `${r ? loopName(t, r) : trackFileName(t)}.mid`);
    setStatus("MIDI downloaded");
  }, [loopRange]);

  /** A fader. It moves the sound at once, and is saved with the take. */
  const setLevel = useCallback((id: ChannelId, db: number) => {
    player.setLevel(id, db);
    const { now } = latest.current;
    const next = { ...now.config.levels, [id]: db };
    if (!db) delete next[id];
    change({ config: { ...now.config, levels: next }, edits: now.edits }, `level:${id}`);
  }, [change]);

  const share = useCallback(async () => {
    const url = shareURL(config, edits);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setStatus("Link copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setStatus("Copy blocked. The link is in the address bar.");
      window.history.replaceState(null, "", url);
    }
  }, [config, edits]);

  return {
    config, edits, track, ready, loadProgress, playing, status, busy, loop, seeks, muted, soloed, source, copied,
    locks, format, update, togglePlay, newTake, randomise, rerollLane, toggleNote, toggleLock, pinRiff, seek, cycleLoop, playFull,
    toggleMute, toggleSolo, setLevel, setFormat, analyse, exportWav, exportLoopWav, exportStems, exportMidi, share,
    hasLoop: inBars(loop) || loop === "section",
    takes: history.takes, canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    undo: undoChange, redo: redoChange, openTake,
  };
}

export type Studio = ReturnType<typeof useStudio>;
