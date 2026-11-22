/**
 * Controls.tsx
 *
 * The control surface. Every control is a real form element, so the
 * whole panel works from the keyboard and with a screen reader.
 */

import type { Studio } from "../hooks/useStudio";
import { LENGTHS } from "../lib/generative-engine";
import { clock, keyName, NOTE_NAMES, STYLES } from "../lib/labels";

export function StylePicker({ studio }: { studio: Studio }) {
  return (
    <fieldset className="styles" aria-label="Style">
      <div className="style-grid">
        {STYLES.map((s) => (
          <label key={s.id} className={studio.config.style === s.id ? "style-card on" : "style-card"}>
            <input type="radio" name="style" checked={studio.config.style === s.id} onChange={() => studio.update({ style: s.id })} />
            <strong>{s.label}</strong>
            <span>{s.desc}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

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
      <div className="panel-head"><h2>Track</h2></div>
      <Slider id="tempo" label="Tempo" hint="Speed of the track" value={config.tempo} min={90} max={175} step={1} show={(v) => `${v} BPM`} onChange={(tempo) => update({ tempo })} />
      <Slider id="energy" label="Energy" hint="Drive, rumble, punch and ride" value={config.energy} show={percent} onChange={(energy) => update({ energy })} />
      <Slider id="mood" label="Light" hint="Phrygian, then minor, then Dorian" value={config.valence} show={percent} onChange={(valence) => update({ valence })} />
      <Slider id="density" label="Density" hint="How many 16ths are filled" value={config.density} show={percent} onChange={(density) => update({ density })} />
      <Slider id="variation" label="Variation" hint="How much each phrase changes" value={config.variation} show={percent} onChange={(variation) => update({ variation })} />

      <fieldset>
        <legend>Length</legend>
        <div className="lengths">
          {LENGTHS.map((bars) => (
            <label key={bars} className={config.bars === bars ? "on" : ""}>
              <input type="radio" name="length" checked={config.bars === bars} onChange={() => update({ bars })} />
              <span>{clock(barSec(bars))}</span>
            </label>
          ))}
        </div>
        <small>{config.bars} bars at {config.tempo} BPM</small>
      </fieldset>

      <fieldset>
        <legend>Key {track && <span className="legend-value">{keyName(track)}</span>}</legend>
        <div className="keys">
          {NOTE_NAMES.map((n, i) => (
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
