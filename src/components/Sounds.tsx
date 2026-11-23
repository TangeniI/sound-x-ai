/**
 * Sounds.tsx
 *
 * Swap each drum sound for another recording, or one of your own. Your own files
 * are kept in this browser, never uploaded, and stay out of share links.
 */

import { useRef, useState } from "react";
import type { Studio } from "../hooks/useStudio";
import { SOUND_CHOICES } from "../lib/audio/kits";
import { SOUND_SLOTS, type SoundSlot } from "../types";

const SLOT_LABEL: Record<SoundSlot, string> = {
  kick: "Kick", snare: "Snare", clap: "Clap", rim: "Rim", hat: "Hat", open: "Open hat", perc: "Perc A", perc2: "Perc B", chord: "Chord",
};

const AUDIO = "audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a";

export function Sounds({ studio }: { studio: Studio }) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<SoundSlot>("kick");
  const [over, setOver] = useState<SoundSlot | null>(null);
  const chosen = studio.config.sounds ?? {};

  const pick = (slot: SoundSlot) => {
    setTarget(slot);
    input.current?.click();
  };

  return (
    <div className="sounds" role="group" aria-label="Sounds">
      <span className="levels-head">Sounds</span>
      {SOUND_SLOTS.map((slot) => (
        <div
          key={slot}
          className={over === slot ? "sound drop" : "sound"}
          onDragOver={(e) => { e.preventDefault(); setOver(slot); }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const file = e.dataTransfer.files[0];
            if (file && slot !== "chord") void studio.addOwnSound(slot, file);
          }}
        >
          <span>{SLOT_LABEL[slot]}</span>
          <select
            aria-label={`${SLOT_LABEL[slot]} sound`}
            value={chosen[slot] ?? ""}
            onChange={(e) => studio.setSound(slot, e.target.value || undefined)}
          >
            <option value="">{slot === "chord" ? "Default (grand piano)" : "Family's"}</option>
            <optgroup label="Recordings">
              {SOUND_CHOICES[slot].map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </optgroup>
            {/* your own chord would need its pitch measured from a single note; not yet */}
            {slot !== "chord" && studio.ownSamples.length > 0 && (
              <optgroup label="Yours">
                {studio.ownSamples.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            )}
          </select>
          {slot === "chord"
            ? <span aria-hidden="true" />
            : <button className="chip own" aria-label={`Use your own ${SLOT_LABEL[slot].toLowerCase()}`} title="Use your own sound (or drop a file here)" onClick={() => pick(slot)}>+</button>}
        </div>
      ))}
      <input
        ref={input} type="file" accept={AUDIO} hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void studio.addOwnSound(target, file);
          e.target.value = "";
        }}
      />
      {studio.ownSamples.length > 0 && (
        <p className="own-list">
          Yours, kept in this browser only:{" "}
          {studio.ownSamples.map((s) => (
            <span key={s.id} className="own-item">
              {s.name}
              <button className="link" aria-label={`Forget ${s.name}`} title="Remove from this browser" onClick={() => void studio.removeOwnSound(s.id)}>×</button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
