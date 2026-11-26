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
import { abletonZip, djToolsZip, download, encodeAudio, encodeMidi, encodeWav, EXTENSION, renderLoop, renderTrack, stemsZip, type FileType, type Range } from "../lib/audio/render";
import { camelot, keyName, type Tags } from "../lib/audio/tags";
import { sliceTrack } from "../lib/audio/slice";
import type { ChannelId } from "../lib/audio/graph";
import { DEFAULT_CONFIG, editPitch, generativeEngine, LENGTHS, newSeed } from "../lib/generative-engine";
import { FAMILIES } from "../lib/groove/families";
import { loopBars } from "../lib/groove/flow";
import { commit, loadHistory, redo, saveHistory, startHistory, undo, type History, type Snapshot } from "../lib/history";
import { NOTE_NAMES, storeGenre } from "../lib/labels";
import { neuralRiff } from "../lib/neural-engine";
import { sampleBank } from "../lib/audio/samples";
import { isOwnSound } from "../lib/audio/kits";
import { addOwnSample, listOwnSamples, removeOwnSample, type OwnSample } from "../lib/audio/own-samples";
import { loadSavedConfig, parseConfigFromURL, shareURL } from "../lib/share";
import { track as count, trackOnce } from "../lib/analytics";
import { drawRoot, drawSetting, emptyTaste, learn, loadTaste, outcomeOf, pickFamily, saveTaste, type TakeFeatures } from "../lib/taste";
import { LANES, type AudioFeatures, type GeneratorConfig, type Lane, type NoteEdit, type SoundSlot, type Track } from "../types";

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

export interface DragFile { kind: "MIDI" | "WAV"; name: string; type: string; url: string }

export interface ExportFormat { bits: 16 | 24; rate: 44100 | 48000; type: FileType }
const FORMAT_KEY = "soundxai.export.v1";
function loadFormat(): ExportFormat {
  try {
    const raw = JSON.parse(localStorage.getItem(FORMAT_KEY) ?? "{}");
    return { bits: raw.bits === 16 ? 16 : 24, rate: raw.rate === 44100 ? 44100 : 48000, type: raw.type === "aiff" || raw.type === "flac" ? raw.type : "wav" };
  } catch {
    return { bits: 24, rate: 48000, type: "wav" };
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

/** Name, key with its Camelot number, tempo and seed: what a DJ sorts a folder by. */
export function trackFileName(track: Track): string {
  const { style, tempo, seed, dj } = track.config;
  const name = track.family ? `groove-${track.family.id}` : style;
  const key = keyName(track.root, track.tonality).replace("#", "s");
  return `sound-x-ai-${name}${dj ? "-dj" : ""}-${key}-${camelot(track.root, track.tonality)}-${tempo}bpm-${seed}`;
}

export function trackTags(track: Track, title: string): Tags {
  return { title, bpm: track.bpm, key: keyName(track.root, track.tonality), camelot: camelot(track.root, track.tonality), genre: storeGenre(track.config.style) };
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
  const [ownSamples, setOwnSamples] = useState<OwnSample[]>([]);

  const ticket = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trackRef = useRef<Track | null>(null);
  const [seeks, setSeeks] = useState(0);
  const latest = useRef(history);

  // Learning from keeps and skips: off until the person turns it on, kept on this device.
  const [taste, setTaste] = useState(loadTaste);
  const tasteRef = useRef(taste);
  const take = useRef<{ features: TakeFeatures; heard: number; touched: boolean; exported: boolean } | null>(null);
  const storeTaste = useCallback((next: typeof taste) => {
    tasteRef.current = next;
    saveTaste(next);
    setTaste(next);
  }, []);
  /** Record what leaving the current take says, if anything. */
  const leaveTake = useCallback(() => {
    const t = take.current;
    take.current = null;
    if (!t || !tasteRef.current.on) return;
    const outcome = outcomeOf(t);
    if (!outcome) return;
    const event = { ...t.features, at: Date.now(), heard: Math.round(t.heard), outcome };
    storeTaste({ ...tasteRef.current, events: [...tasteRef.current.events, event] });
  }, [storeTaste]);
  /** Only Groove takes count: Randomise only steers Groove. */
  const beginTake = useCallback((c: GeneratorConfig) => {
    take.current = c.style === "driving" && c.family
      ? {
          features: { family: c.family, tempo: c.tempo, root: c.rootPitch, energy: c.energy, valence: c.valence, density: c.density, variation: c.variation },
          heard: 0, touched: false, exported: false,
        }
      : null;
  }, []);

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
  const change = useCallback((next: Snapshot, tag = "") => {
    // any change to a take is work on it; a new take calls beginTake after this
    if (take.current) take.current.touched = true;
    show(commit(latest.current, next, tag));
  }, [show]);

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
    trackOnce("play");
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
    trackOnce("new-take");
    player.unlock();
    if (locks.size) return rewriteUnlocked();
    // a Groove stays in its family: Randomise is what changes the idea
    const family = config.style === "driving" ? trackRef.current?.family?.id ?? config.family : config.family;
    const next = { ...config, family, seed: newSeed(), laneSeeds: {}, pins: {} };
    leaveTake();
    change({ config: next, edits: [] });
    beginTake(next);
    setStatus(`New take #${next.seed}`);
    await rebuild(next, [], 0);
  }, [config, change, rebuild, locks, rewriteUnlocked, leaveTake, beginTake]);

  /**
   * Randomise is Groove only until the other styles have had the same work. It
   * picks a family, then varies it inside the limits that family was written for.
   * With parts locked it keeps the family, and rewrites the rest.
   */
  const randomise = useCallback(async () => {
    trackOnce("randomise");
    player.unlock();
    if (locks.size) return rewriteUnlocked();
    const others = FAMILIES.filter((f) => f.id !== trackRef.current?.family?.id);
    // with learning on, lean towards what this person keeps; off, every draw is even
    const learned = tasteRef.current.on ? learn(tasteRef.current.events) : emptyTaste();
    const id = pickFamily(learned, others.map((f) => f.id));
    const family = others.find((f) => f.id === id)!;
    const draw = (key: "energy" | "valence" | "density" | "variation", lo: number, hi: number) =>
      Math.round(drawSetting(learned, id, key, lo, hi) * 100) / 100;
    const next: GeneratorConfig = {
      ...config,
      style: "driving",
      family: family.id,
      tempo: Math.min(family.tempo[1], Math.floor(drawSetting(learned, id, "tempo", family.tempo[0], family.tempo[1] + 1))),
      energy: draw("energy", 0.62, 0.85),
      valence: draw("valence", 0.12, 0.45),
      density: draw("density", 0.5, 0.8),
      variation: draw("variation", 0.25, 0.55),
      rootPitch: drawRoot(learned, id, family.keys),
      mode: "auto",
      seed: newSeed(),
      laneSeeds: {},
      pins: {},
    };
    leaveTake();
    change({ config: next, edits: [] });
    beginTake(next);
    setStatus(`${family.name} in ${NOTE_NAMES[next.rootPitch]} at ${next.tempo} BPM`);
    if (!inBars(loopRef.current)) {
      loopRef.current = "eight";
      setLoop("eight");
    }
    player.loop = true;
    await rebuild(next, [], 0);
  }, [config, change, rebuild, locks, rewriteUnlocked, leaveTake, beginTake]);

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
      if (take.current) take.current.exported = true;
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const levels = () => latest.current.now.config.levels ?? {};
  const encode = (audio: AudioBuffer, tags: Tags) => encodeAudio(audio, format.type, format.bits, tags);
  const fileName = (name: string) => `${name}.${EXTENSION[format.type]}`;
  const loopName = (t: Track, r: Range) => `${trackFileName(t)}-bars${r.startBar + 1}-${r.startBar + r.bars}`;

  const exportWav = useCallback(() => exporting("Rendering the mix", async (t) => {
    const audio = await renderTrack(t, sampleRate(), {
      audible: player.audible(), levels: levels(), rate: format.rate,
      onProgress: (p) => setStatus(`Rendering the mix ${Math.round(p * 100)}%`),
    });
    const name = trackFileName(t);
    download(encode(audio, trackTags(t, name)), fileName(name));
    count(`export-mix-${format.type}${t.config.dj ? "-dj" : ""}`);
    setStatus(`${format.type.toUpperCase()} downloaded, tagged ${trackTags(t, name).camelot} at ${t.bpm} BPM`);
  }), [exporting, format]);

  const exportLoopWav = useCallback(() => exporting("Rendering loop", async (t) => {
    const r = loopRange();
    if (!r) return setStatus("Choose a bar or section loop first");
    const audio = await renderLoop(t, r.startBar, r.bars, sampleRate(), {
      audible: player.audible(), levels: levels(), rate: format.rate,
      onProgress: (p) => setStatus(`Rendering loop ${Math.round(p * 100)}%`),
    });
    const name = loopName(t, r);
    download(encode(audio, trackTags(t, name)), fileName(name));
    count(`export-loop-${format.type}`);
    setStatus(`Loop downloaded: ${r.bars} bars at ${t.bpm} BPM`);
  }), [exporting, format, loopRange]);

  const exportStems = useCallback((loopOnly: boolean) => exporting("Rendering stems", async (t) => {
    const range = loopOnly ? loopRange() : undefined;
    if (loopOnly && !range) return setStatus("Choose a bar or section loop first");
    const name = range ? loopName(t, range) : trackFileName(t);
    const zip = await stemsZip(t, sampleRate(), player.audible(), name, {
      range: range ?? undefined, bits: format.bits, rate: format.rate, type: format.type, levels: levels(),
      onProgress: (p, stem) => setStatus(`Rendering stems ${Math.round(p * 100)}%, ${stem}`),
    });
    download(zip, `${name}-stems.zip`);
    count(range ? "export-loop-stems" : "export-stems");
    setStatus("Stems downloaded");
  }), [exporting, format, loopRange]);

  /**
   * The take, or just the loop, as an Ableton Live project: stems on audio tracks,
   * the parts as MIDI, the sections marked.
   */
  const exportAbleton = useCallback((loopOnly: boolean) => exporting("Building the Live set", async (t) => {
    const range = loopOnly ? loopRange() : undefined;
    if (loopOnly && !range) return setStatus("Choose a bar or section loop first");
    const name = range ? loopName(t, range) : trackFileName(t);
    const zip = await abletonZip(t, sampleRate(), player.audible(), name, {
      range: range ?? undefined, bits: format.bits, rate: format.rate, levels: levels(),
      onProgress: (p, stem) => setStatus(`Building the Live set ${Math.round(p * 100)}%, ${stem}`),
    });
    download(zip, `${name}-ableton.zip`);
    count(range ? "export-loop-ableton" : "export-ableton");
    setStatus("Live set downloaded: unzip it and open the .als in Ableton Live 12");
  }), [exporting, format, loopRange]);

  // time heard on the current take, and what it said when the page closes
  useEffect(() => {
    if (tasteRef.current.on && !take.current) beginTake(latest.current.now.config);
    // the activation we watch: 30 seconds of listening in a visit
    let listened = 0;
    const tick = setInterval(() => {
      if (!player.playing) return;
      if (take.current) take.current.heard += 1;
      if (++listened === 30) trackOnce("listened-30s");
    }, 1000);
    addEventListener("pagehide", leaveTake);
    return () => { clearInterval(tick); removeEventListener("pagehide", leaveTake); };
  }, [leaveTake, beginTake]);

  const setTasteOn = useCallback((on: boolean) => {
    storeTaste({ ...tasteRef.current, on });
    if (on) count("taste-on");
    if (on && !take.current) beginTake(latest.current.now.config);
    setStatus(on ? "Learning from what you keep and skip, in this browser only" : "Stopped learning. What it learned stays until you forget it");
  }, [storeTaste, beginTake]);
  const forgetTaste = useCallback(() => {
    storeTaste({ ...tasteRef.current, events: [] });
    setStatus("Forgot every keep and skip");
  }, [storeTaste]);
  const exportTaste = useCallback(() => {
    download(new Blob([JSON.stringify(tasteRef.current.events, null, 1)], { type: "application/json" }), "sound-x-ai-taste.json");
  }, []);

  const exportDjTools = useCallback(() => exporting("Rendering DJ tools", async (t) => {
    const name = trackFileName(t);
    const zip = await djToolsZip(t, sampleRate(), name, peakBars(t, 16), {
      bits: format.bits, rate: format.rate, type: format.type, levels: levels(), tags: (title) => trackTags(t, title),
      onProgress: (p, what) => setStatus(`Rendering DJ tools ${Math.round(p * 100)}%, ${what}`),
    });
    download(zip, `${name}-dj-tools.zip`);
    count("export-dj-tools");
    setStatus("DJ tools downloaded: drum loop, tops loop, the build, and the drums as MIDI");
  }), [exporting, format]);

  /**
   * Files to drag straight into a DAW: the loop's MIDI and audio, made ahead because
   * a drag has to name its file the moment it starts. Chrome and Edge only.
   */
  const prepareDrag = useCallback(async (): Promise<DragFile[]> => {
    const t = trackRef.current;
    const r = loopRange();
    if (!t || !r) return [];
    const name = loopName(t, r);
    const midi = await encodeMidi(sliceTrack(t, r.startBar, r.bars), player.audible());
    const audio = await renderLoop(t, r.startBar, r.bars, sampleRate(), { audible: player.audible(), levels: levels(), rate: format.rate });
    return [
      { kind: "MIDI", name: `${name}.mid`, type: "audio/midi", url: URL.createObjectURL(midi) },
      { kind: "WAV", name: `${name}.wav`, type: "audio/wav", url: URL.createObjectURL(encodeWav(audio, format.bits, trackTags(t, name))) },
    ];
  }, [loopRange, format]);
  const draggedOut = useCallback((kind: string) => {
    if (take.current) take.current.exported = true;
    count(`drag-${kind.toLowerCase()}`);
  }, []);

  const exportMidi = useCallback(async (loopOnly = false) => {
    const t = trackRef.current;
    if (!t) return;
    const r = loopOnly ? loopRange() : null;
    if (loopOnly && !r) return setStatus("Choose a bar or section loop first");
    const part = r ? sliceTrack(t, r.startBar, r.bars) : t;
    download(await encodeMidi(part, player.audible()), `${r ? loopName(t, r) : trackFileName(t)}.mid`);
    if (take.current) take.current.exported = true;
    count(r ? "export-loop-midi" : "export-midi");
    setStatus("MIDI downloaded");
  }, [loopRange]);

  // the producer's own sounds. One that isn't on this device (a session from another
  // browser, or a deleted file) goes back to the family's sound rather than a stand-in.
  useEffect(() => {
    void listOwnSamples().then((list) => {
      setOwnSamples(list);
      const have = new Set(list.map((x) => x.id));
      const sounds = latest.current.now.config.sounds ?? {};
      const gone = Object.entries(sounds).filter(([, id]) => id && isOwnSound(id) && !have.has(id));
      if (!gone.length) return;
      const kept = Object.fromEntries(Object.entries(sounds).filter(([, id]) => !(id && isOwnSound(id) && !have.has(id))));
      const { now } = latest.current;
      show({ ...latest.current, now: { config: { ...now.config, sounds: kept }, edits: now.edits } });
      void rebuild(latest.current.now.config, latest.current.now.edits);
      setStatus(`${gone.length} of your own sound${gone.length > 1 ? "s isn't" : " isn't"} on this device, so the family's plays instead`);
    });
  }, [rebuild, show]);

  /** Swap a sound for another recording, or back to the family's (no id). Kept through new takes. */
  const setSound = useCallback((slot: SoundSlot, id?: string) => {
    const sounds = { ...latest.current.now.config.sounds };
    if (id) sounds[slot] = id; else delete sounds[slot];
    update({ sounds });
  }, [update]);

  /** Keep a file of the producer's own in this browser and play it in `slot`. */
  const addOwnSound = useCallback(async (slot: SoundSlot, file: File) => {
    try {
      const sample = await addOwnSample(file, slot === "kick");
      setOwnSamples((list) => [...list.filter((x) => x.id !== sample.id), sample]);
      setSound(slot, sample.id);
      count("own-sample");
      setStatus(`${sample.name} is your ${slot === "perc2" ? "second perc" : slot}. It stays in this browser.`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, [setSound]);

  const removeOwnSound = useCallback(async (id: string) => {
    await removeOwnSample(id);
    setOwnSamples((list) => list.filter((x) => x.id !== id));
    const sounds = latest.current.now.config.sounds ?? {};
    const kept = Object.fromEntries(Object.entries(sounds).filter(([, v]) => v !== id));
    if (Object.keys(kept).length !== Object.keys(sounds).length) update({ sounds: kept });
  }, [update]);

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
      count("share");
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
    locks, format, ownSamples, setSound, addOwnSound, removeOwnSound, update, togglePlay, newTake, randomise, rerollLane, toggleNote, toggleLock, pinRiff, seek, cycleLoop, playFull,
    toggleMute, toggleSolo, setLevel, setFormat, analyse, exportWav, exportLoopWav, exportStems, exportMidi, exportAbleton, exportDjTools, share, prepareDrag, draggedOut,
    taste, setTasteOn, forgetTaste, exportTaste,
    hasLoop: inBars(loop) || loop === "section",
    takes: history.takes, canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    undo: undoChange, redo: redoChange, openTake,
  };
}

export type Studio = ReturnType<typeof useStudio>;
