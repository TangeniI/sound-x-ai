/**
 * hooks/useMidi.ts
 *
 * MIDI out, kept apart from the studio: it only follows playback. Nothing is
 * asked of the browser until the producer presses Connect, because the browser
 * shows a permission prompt for MIDI.
 */

import { track } from "../lib/analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { player } from "../lib/audio/player";
import { MidiOut, midiSupported } from "../lib/midi";

const KEY = "soundxai.midi.v1";

interface Saved { port?: string; clock?: boolean }

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { port: typeof raw.port === "string" ? raw.port : undefined, clock: raw.clock !== false };
  } catch {
    return { clock: true };
  }
}

function save(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ }
}

export function useMidi() {
  const midi = useRef<MidiOut | null>(null);
  const [connected, setConnected] = useState(false);
  const [ports, setPorts] = useState<{ id: string; name: string }[]>([]);
  const [port, setPort] = useState<string | null>(null);
  const [clock, setClockState] = useState(load().clock !== false);
  const [speaker, setSpeakerState] = useState(true);
  const [error, setError] = useState("");

  const out = () => (midi.current ??= new MidiOut(() => player.context()));

  const choose = useCallback((id: string | null) => {
    const m = out();
    m.select(id);
    setPort(m.selected);
    player.listener = m.selected ? m : null;
    const name = m.ports().find((p) => p.id === id)?.name;
    save({ ...load(), port: name });
    if (!m.selected) {
      // with nothing to play, the browser's sound comes back on
      player.setSpeaker(true);
      setSpeakerState(true);
    }
  }, []);

  const connect = useCallback(async () => {
    setError("");
    try {
      const m = out();
      const list = await m.connect();
      track("midi-connect");
      m.onPorts = (next) => {
        setPorts(next);
        if (m.selected && !next.some((p) => p.id === m.selected)) choose(null);
      };
      setPorts(list);
      setConnected(true);
      const remembered = list.find((p) => p.name === load().port);
      choose(remembered?.id ?? list[0]?.id ?? null);
      if (!list.length) setError("No MIDI outputs. On a Mac, turn on the IAC Driver in Audio MIDI Setup.");
    } catch (e) {
      setError((e as Error).name === "SecurityError" || (e as Error).name === "NotAllowedError"
        ? "MIDI was blocked. Allow it in the browser's site settings."
        : (e as Error).message);
    }
  }, [choose]);

  const setClock = useCallback((on: boolean) => {
    out().clock = on;
    setClockState(on);
    save({ ...load(), clock: on });
  }, []);

  const setSpeaker = useCallback((on: boolean) => {
    player.setSpeaker(on);
    setSpeakerState(on);
  }, []);

  useEffect(() => {
    out().clock = clock;
    return () => { if (player.listener === midi.current) player.listener = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported: midiSupported(), connected, ports, port, clock, speaker, error, connect, choose, setClock, setSpeaker };
}

export type Midi = ReturnType<typeof useMidi>;
