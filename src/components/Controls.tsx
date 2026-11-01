/**
 * Controls.tsx
 *
 * The left-hand control surface. Every control is a real form element, so the
 * whole panel works from the keyboard and with a screen reader.
 */

import type { Studio } from "../hooks/useStudio";
import { LENGTHS } from "../lib/generative-engine";
import type { StyleId } from "../types";

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const STYLES: { id: StyleId; label: string; desc: string }[] = [
  { id: "driving", label: "Driving", desc: "909s, rolling bass" },
  { id: "hypnotic", label: "Hypnotic", desc: "808s, deep groove" },
  { id: "acid", label: "Acid", desc: "squelching 303 line" },
  { id: "melodic", label: "Melodic", desc: "FM chords, pads" },
  { id: "dub", label: "Dub", desc: "chords in tape echo" },
  { id: "warehouse", label: "Warehouse", desc: "rumble, anvil, brake drum" },
];

interface SliderProps {
  id: string;
  label: string;
  hint: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  show: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({ id, label, hint, value, min = 0, max = 1, step = 0.01, show, onChange }: SliderProps) {
  return (
    <div className="slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id}>{show(value)}</output>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-describedby={`${id}-hint`} onChange={(e) => onChange(Number(e.target.value))} />
      <small id={`${id}-hint`}>{hint}</small>
    </div>
  );
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

export default function Controls({ studio }: { studio: Studio }) {
  const { config, track, update } = studio;
  const barSec = (bars: number) => (bars * 240) / config.tempo;

  return (
    <section className="panel controls" aria-label="Track controls">
      <fieldset className="styles">
        <legend>Style</legend>
        <div className="style-grid">
          {STYLES.map((s) => (
            <label key={s.id} className={config.style === s.id ? "style-card on" : "style-card"}>
              <input type="radio" name="style" checked={config.style === s.id} onChange={() => update({ style: s.id })} />
              <strong>{s.label}</strong>
              <span>{s.desc}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Slider id="tempo" label="Tempo" hint="Speed of the track" value={config.tempo} min={90} max={175} step={1} show={(v) => `${v} BPM`} onChange={(tempo) => update({ tempo })} />
      <Slider id="energy" label="Energy" hint="Drive, rumble, punch and layers" value={config.energy} show={percent} onChange={(energy) => update({ energy })} />
      <Slider id="mood" label="Mood" hint="Dark scales to bright ones" value={config.valence} show={percent} onChange={(valence) => update({ valence })} />
      <Slider id="density" label="Density" hint="How busy the rhythm is" value={config.density} show={percent} onChange={(density) => update({ density })} />
      <Slider id="variation" label="Variation" hint="How far the riff strays" value={config.variation} show={percent} onChange={(variation) => update({ variation })} />

      <fieldset>
        <legend>Length</legend>
        <div className="segmented">
          {LENGTHS.map((bars) => (
            <label key={bars} className={config.bars === bars ? "on" : ""}>
              <input type="radio" name="length" checked={config.bars === bars} onChange={() => update({ bars })} />
              <span>{bars}</span>
            </label>
          ))}
        </div>
        <small>{config.bars} bars, about {Math.round(barSec(config.bars))} seconds</small>
      </fieldset>

      <fieldset>
        <legend>Key {track && <span className="legend-value">{NOTES[track.root]} {track.tonality}</span>}</legend>
        <div className="keys">
          {NOTES.map((n, i) => (
            <label key={n} className={config.rootPitch === i ? "on" : ""}>
              <input type="radio" name="key" checked={config.rootPitch === i} onChange={() => update({ rootPitch: i })} />
              <span>{n}</span>
            </label>
          ))}
        </div>
        <div className="segmented small">
          {(["auto", "minor", "major"] as const).map((mode) => (
            <label key={mode} className={config.mode === mode ? "on" : ""}>
              <input type="radio" name="mode" checked={config.mode === mode} onChange={() => update({ mode })} />
              <span>{mode}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
