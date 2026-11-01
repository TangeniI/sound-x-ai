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
import { download, encodeMidi, encodeWav, renderTrack, STEM_GROUPS } from "../lib/audio/render";
import type { ChannelId } from "../lib/audio/graph";
import { DEFAULT_CONFIG, generativeEngine, LENGTHS, newSeed } from "../lib/generative-engine";
import { neuralRiff } from "../lib/neural-engine";
import { loadSavedConfig, parseConfigFromURL, saveConfig, shareURL } from "../lib/share";
import type { AudioFeatures, GeneratorConfig, Lane, NoteEdit, StyleId, Track } from "../types";

export type LoopMode = "track" | "section" | "off";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const STYLE_IDS: StyleId[] = ["driving", "hypnotic", "acid", "melodic", "dub", "warehouse"];

function initialState(): { config: GeneratorConfig; edits: NoteEdit[]; fromLink: boolean } {
  const { config: linked, edits } = parseConfigFromURL();
  const fromLink = Object.keys(linked).length > 0;
  const saved = fromLink ? {} : loadSavedConfig();
  const { seed: _s, laneSeeds: _l, pins: _p, ...controls } = saved;
  const config = { ...DEFAULT_CONFIG, ...controls, ...linked };
  if (!LENGTHS.includes(config.bars)) config.bars = DEFAULT_CONFIG.bars;
  return { config, edits, fromLink };
}

export function trackFileName(track: Track): string {
  const { style, tempo, seed } = track.config;
  return `sound-x-ai-${style}-${NOTE_NAMES[track.root].replace("#", "s")}-${tempo}bpm-${seed}`;
}

export function useStudio() {
  const [{ config: firstConfig, edits: firstEdits, fromLink }] = useState(initialState);
  const [config, setConfig] = useState(firstConfig);
  const [edits, setEdits] = useState(firstEdits);
  const [track, setTrack] = useState<Track | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState(fromLink ? "Shared track loaded. Press play." : "");
  const [busy, setBusy] = useState(false);
  const [loop, setLoop] = useState<LoopMode>("track");
  const [muted, setMuted] = useState<Set<ChannelId>>(new Set());
  const [soloed, setSoloed] = useState<Set<ChannelId>>(new Set());
  const [source, setSource] = useState<AudioFeatures | null>(null);
  const [copied, setCopied] = useState(false);

  const ticket = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trackRef = useRef<Track | null>(null);

  /** Write the track for a config and hand it to the player. */
  const rebuild = useCallback(async (cfg: GeneratorConfig, ed: NoteEdit[], from?: number) => {
    const mine = ++ticket.current;
    const next = generativeEngine.generate(cfg, ed);
    if (!trackRef.current) setLoadProgress(0);
    await player.prepare(cfg.style, next.tonality, (p) => {
      if (!trackRef.current) setLoadProgress(p);
    });
    if (mine !== ticket.current) return;
    trackRef.current = next;
    player.setTrack(next);
    setTrack(next);
    setReady(true);
    if (from != null) {
      await player.play(from);
      setPlaying(true);
    }
  }, []);

  // first load: fetch the model, then write the first track
  useEffect(() => {
    let live = true;
    void neuralRiff.load().then(() => { if (live) void rebuild(firstConfig, firstEdits); });
    player.onEnd = () => setPlaying(false);
    return () => { live = false; };
  }, [rebuild, firstConfig, firstEdits]);

  useEffect(() => {
    const { seed: _s, laneSeeds: _l, pins: _p, ...controls } = config;
    saveConfig(controls);
  }, [config]);

  /** Change controls. The take stays the same, and the music updates as you move. */
  const update = useCallback((patch: Partial<GeneratorConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setEdits((ed) => { void rebuild(next, ed); return ed; });
      }, 90);
      return next;
    });
  }, [rebuild]);

  const togglePlay = useCallback(async () => {
    player.unlock();
    if (player.playing) {
      player.stop();
      setPlaying(false);
      return;
    }
    await player.play(player.position());
    setPlaying(true);
  }, []);

  /** A new take of the current style and controls. */
  const newTake = useCallback(async () => {
    player.unlock();
    const next = { ...config, seed: newSeed(), laneSeeds: {}, pins: {} };
    setConfig(next);
    setEdits([]);
    setStatus(`New take #${next.seed}`);
    await rebuild(next, [], 0);
  }, [config, rebuild]);

  const randomise = useCallback(async () => {
    player.unlock();
    const rnd = (lo: number, hi: number) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
    const next: GeneratorConfig = {
      ...config,
      style: STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)],
      tempo: Math.round(rnd(124, 140)),
      energy: rnd(0.5, 0.95),
      valence: rnd(0.1, 0.72),
      density: rnd(0.45, 0.9),
      variation: rnd(0.2, 0.6),
      rootPitch: Math.floor(Math.random() * 12),
      mode: "auto",
      seed: newSeed(),
      laneSeeds: {},
      pins: {},
    };
    setConfig(next);
    setEdits([]);
    setStatus(`${next.style} in ${NOTE_NAMES[next.rootPitch]} at ${next.tempo} BPM`);
    await rebuild(next, [], 0);
  }, [config, rebuild]);

  /** Rewrite one lane and keep the rest of the track. */
  const rerollLane = useCallback((lane: Lane) => {
    const nextEdits = edits.filter((e) => e.lane !== lane);
    const next = { ...config, laneSeeds: { ...config.laneSeeds, [lane]: (config.laneSeeds[lane] ?? 0) + 1 } };
    setConfig(next);
    setEdits(nextEdits);
    void rebuild(next, nextEdits);
  }, [config, edits, rebuild]);

  const toggleNote = useCallback((lane: Lane, step: number, pitch: number) => {
    const t = trackRef.current;
    if (!t) return;
    const exists = t.notes.some((n) => n.instrument === lane && n.step === step && n.pitch === pitch);
    const undo = edits.findIndex((e) => e.lane === lane && e.step === step && e.pitch === pitch);
    const nextEdits = undo >= 0
      ? edits.filter((_, i) => i !== undo)
      : [...edits, { op: exists ? "remove" as const : "add" as const, lane, step, pitch }];
    setEdits(nextEdits);
    const next = generativeEngine.generate(config, nextEdits);
    trackRef.current = next;
    setTrack(next);
    player.updateNotes(next.notes);
  }, [config, edits]);

  /** Hold (or release) a note in the riff. The model continues from it. */
  const pinRiff = useCallback((step: number, token: number) => {
    const pins = { ...config.pins };
    if (pins[step] === token) delete pins[step];
    else pins[step] = token;
    const next = { ...config, pins };
    setConfig(next);
    void rebuild(next, edits);
  }, [config, edits, rebuild]);

  const seek = useCallback((seconds: number) => {
    player.seek(seconds);
    if (!player.playing) setTrack((t) => (t ? { ...t } : t));
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
    setLoop((mode) => {
      const next: LoopMode = mode === "track" ? "section" : mode === "section" ? "off" : "track";
      player.loop = next !== "off";
      player.setRange(next === "section" ? sectionRange() : null);
      return next;
    });
  }, [sectionRange]);

  /* ──────────────────────────── mixer ─────────────────────────────── */

  const toggleMute = useCallback((id: ChannelId) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      player.setMute(id, next.has(id));
      return next;
    });
  }, []);

  const toggleSolo = useCallback((id: ChannelId) => {
    setSoloed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      player.setSolo(id, next.has(id));
      return next;
    });
  }, []);

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

  const exportWav = useCallback(async () => {
    const t = trackRef.current;
    if (!t) return;
    setBusy(true);
    setStatus("Rendering WAV");
    try {
      download(encodeWav(await renderTrack(t, sampleRate())), `${trackFileName(t)}.wav`);
      setStatus("WAV downloaded");
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const exportStems = useCallback(async () => {
    const t = trackRef.current;
    if (!t) return;
    setBusy(true);
    try {
      for (const [name, channels] of Object.entries(STEM_GROUPS)) {
        setStatus(`Rendering ${name} stem`);
        download(encodeWav(await renderTrack(t, sampleRate(), channels)), `${trackFileName(t)}-${name}.wav`);
        await new Promise((r) => setTimeout(r, 350)); // browsers drop downloads fired together
      }
      setStatus("Stems downloaded");
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const exportMidi = useCallback(async () => {
    const t = trackRef.current;
    if (!t) return;
    download(await encodeMidi(t), `${trackFileName(t)}.mid`);
    setStatus("MIDI downloaded");
  }, []);

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
    config, edits, track, ready, loadProgress, playing, status, busy, loop, muted, soloed, source, copied,
    update, togglePlay, newTake, randomise, rerollLane, toggleNote, pinRiff, seek, cycleLoop, toggleMute,
    toggleSolo, analyse, exportWav, exportStems, exportMidi, share,
  };
}

export type Studio = ReturnType<typeof useStudio>;
