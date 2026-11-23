/**
 * MidiPanel.tsx
 *
 * Send the track to the producer's own instruments over MIDI, with clock.
 */

import type { Midi } from "../hooks/useMidi";

export function MidiPanel({ midi }: { midi: Midi }) {
  if (!midi.supported) {
    return <p className="licence">This browser has no Web MIDI. Chrome, Edge and Firefox do.</p>;
  }
  if (!midi.connected) {
    return (
      <>
        <p className="licence">
          Play the track on your own drum machine, synth or DAW instruments. The browser will ask to allow MIDI.
        </p>
        <button role="menuitem" onClick={() => void midi.connect()}>Connect MIDI</button>
        {midi.error && <p className="licence error">{midi.error}</p>}
      </>
    );
  }
  return (
    <>
      <label className="midi-row">
        <span>Output</span>
        <select value={midi.port ?? ""} onChange={(e) => midi.choose(e.target.value || null)} aria-label="MIDI output">
          <option value="">Off</option>
          {midi.ports.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="format" role="group" aria-label="MIDI options">
        <button aria-pressed={midi.clock} onClick={() => midi.setClock(!midi.clock)} title="Clock, start, stop and song position, so your DAW follows">Send clock</button>
        <button aria-pressed={!midi.speaker} disabled={!midi.port} onClick={() => midi.setSpeaker(!midi.speaker)} title="Only your instruments play">Mute browser</button>
      </div>
      {midi.error && <p className="licence error">{midi.error}</p>}
      <p className="licence">
        Channels: lead 1, pad 2, stab 3, bass 4, drums and percussion 10, on General MIDI drum notes
        (kick 36, snare 38, clap 39, closed hat 42, open hat 46). Muted parts aren't sent.
        In Ableton, set a MIDI track's input to this port and its channel, and turn on Sync
        for the port in Settings → Link, Tempo &amp; MIDI to follow the clock.
      </p>
    </>
  );
}
