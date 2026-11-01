/**
 * Credits.tsx
 *
 * Where every sound comes from. The York impulse responses are CC BY, so this
 * attribution has to stay in the app.
 */

import { useEffect, useRef } from "react";

const SOURCES: { what: string; from: string; href: string; licence: string }[] = [
  { what: "TR-808 drums and cymbals", from: "Michael Fischer's recordings of the original analogue machine, 1994", href: "https://github.com/tidalcycles/sounds-tr808-fischer", licence: "CC0" },
  { what: "909, drum sounds", from: "Roland TR-8 hardware, recorded by MckAudio", href: "https://github.com/MckAudio/MckSamplePacks", licence: "CC0" },
  { what: "Pads, chords and percussion", from: "Donated by The Black Dog to Sonic Pi", href: "https://github.com/sonic-pi-net/sonic-pi", licence: "CC0" },
  { what: "Kicks, basses, guitar chord, vinyl", from: "Freesound contributors, via the Sonic Pi library", href: "https://github.com/sonic-pi-net/sonic-pi/blob/main/etc/samples/README.md", licence: "CC0" },
  { what: "FM keys", from: "Yamaha TX81Z hardware, Versilian Community Sample Library", href: "https://github.com/sgossner/VCSL", licence: "CC0" },
  { what: "Anvil, brake drum, gong, hand claps", from: "Versilian Community Sample Library", href: "https://github.com/sgossner/VCSL", licence: "CC0" },
  { what: "Hall and room reverb", from: "Impulse responses of the Divinity School, Oxford, and York Guildhall, by the University of York AudioLab, from House of Commons - Acoustic Reconstruction 1820-34. Trimmed and combined to stereo.", href: "https://zenodo.org/record/7560885", licence: "CC BY 4.0" },
  { what: "Riff training data", from: "Lakh MIDI Dataset, Colin Raffel, 2016. Used for training only, and not included here.", href: "https://colinraffel.com/projects/lmd/", licence: "research dataset" },
];

export default function Credits({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog ref={dialog} className="credits" onClose={onClose} aria-labelledby="credits-title">
      <div className="panel-head">
        <h2 id="credits-title">Sounds &amp; credits</h2>
        <button className="link" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <p>Every sound is a real recording. Machines, metal and rooms were captured, then repitched, filtered and driven here, in your browser.</p>
      <ul>
        {SOURCES.map((s) => (
          <li key={s.what}>
            <strong>{s.what}</strong>
            <span>{s.from} <a href={s.href} target="_blank" rel="noreferrer">Source ↗</a> <em>{s.licence}</em></span>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
