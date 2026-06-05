# Sound × AI — Generative Techno Engine

A generative music studio that synthesises original **techno** tracks from a learned
model of musical structure — not genre samples. It runs **entirely in the browser**:
no backend, no API keys, no account.

Pick a style and shape the track with the controls, or **drop in any audio file** and
it analyses the track in-browser (tempo, key, energy, brightness) and clones its
"DNA" to seed the generation.

> **Live demo:** _your Vercel URL_ · works instantly on first click.

---

## What makes it tick

Generation works the way techno actually works — patterns and arrangement, not
random notes ([`src/lib/generative-engine.ts`](src/lib/generative-engine.ts)):

| Technique | What it does |
|---|---|
| **Pattern-based generation** | One bassline, one stab loop and one lead riff are generated *once*, then repeated across the arrangement with light mutation. Repetition is what makes techno hypnotic. |
| **Markov riff model** | The lead motif is sampled from a transition matrix trained at load on a corpus of motifs — a riff, not a stream of notes. |
| **Driving bassline** | Roots / fifths / octaves placed *between* the kicks for the pumping feel, or a 303-style acid line, depending on the style. |
| **Programmed drums** | Four-on-the-floor kick, offbeat open hats, clap on 2 & 4, 16th-note closed hats. |
| **Arrangement** | A per-bar layer map (drive → full → breakdown → build → drop) gates which elements play, so a track has a journey. |

**Styles:** `DRIVING` (peak-time), `HYPNOTIC` (minimal), `ACID` (303 line), `MELODIC` (pads).

### In-browser audio analysis

Drop in a track and [`src/lib/audio-analysis.ts`](src/lib/audio-analysis.ts) runs real
DSP on it — nothing is uploaded:

- **RMS loudness** → energy
- **Spectral centroid (FFT)** → brightness
- **Chroma analysis** → musical key (root + major/minor)
- **Onset-flux autocorrelation** → tempo

Tempo, key and energy are then locked into the generator, so the output shares the
input's *feel* — it generates an original track in that DNA, it doesn't remix.

## Stack

- **Vite + React + TypeScript**
- **Tone.js** — synthesis + Web Audio scheduling; MIDI export via `@tonejs/midi`
- **Framer Motion** — UI + character animation
- **Web Audio API** — in-browser FFT / chroma analysis
- Canvas visualisers: DAW-style 4-lane piano-roll, radar "DNA" chart, **REZ-909**
  (a beat-reactive pixel droid), and an audio-reactive matrix background

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build → dist/
npm run preview  # serve the production build
```

No environment variables required.

## Project structure

```
src/
├── components/
│   ├── AudioReactiveBackground.tsx   matrix/particle canvas, beat-reactive
│   ├── CharacterDisplay.tsx          REZ-909, the dancing pixel droid
│   ├── DNARadar.tsx                  radar chart of the current DNA vector
│   ├── GeneratorPanel.tsx            style + control surface
│   ├── TrackTimeline.tsx             scrolling 4-lane DAW piano-roll
│   └── AudioDropzone.tsx             drag-in track → in-browser analysis
├── lib/
│   ├── generative-engine.ts          the techno engine (patterns + arrangement)
│   ├── audio-analysis.ts             Web Audio FFT + chroma key detection
│   └── tone-synth.ts                 Tone.js synthesis + MIDI export
├── types.ts
└── App.tsx
```

---

Built by [Tangeni Idhenga](https://www.tangeniidhenga.com).
