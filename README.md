# Sound × AI — Generative Audio Engine

A generative music studio that synthesises original tracks from a learned model of
**temporal structure, tension and release** — rather than stitching together genre
samples. It runs **entirely in the browser**: no backend, no API keys, no account.

Drive it with the controls, or **drop in any audio file** and it will analyse the
track in-browser and clone its "DNA" (tempo, energy, brightness, groove) to seed
the generation.

> **Live demo:** _added after deploy_ · **Default engine works instantly on first click.**

---

## What makes it tick

Generation is not random notes. Four real techniques cooperate inside the in-house
engine ([`src/lib/generative-engine.ts`](src/lib/generative-engine.ts)):

| Technique | What it does |
|---|---|
| **Markov melody model** | A first-order transition matrix *trained at load* from a corpus of idiomatic motifs. Generation walks the chain; the `variation` control blends the learned distribution with uniform noise (temperature). |
| **Functional harmony** | A weighted progression generator picks chord functions (tonic / subdominant / dominant) by tension, voicing them as triads → 7ths → 9ths as tension climbs. |
| **Euclidean rhythm** | Bjorklund's algorithm distributes hi-hat onsets as evenly as possible across 16 steps; kick/snare ride a four-on-the-floor backbone gated by the tension envelope. |
| **Tension / release envelope** | A parametric arc (build → peak → drop → release) modulates note density, register, chord extensions and drum fullness — so tracks have structure, not just texture. |

Everything is conditioned by an `AudioFeatures` vector that comes from the controls
or from **in-browser audio analysis** ([`src/lib/audio-analysis.ts`](src/lib/audio-analysis.ts)):
RMS loudness → energy, spectral centroid (FFT) → brightness, onset-flux
autocorrelation → tempo, onset regularity → danceability.

### Optional deep mode

A toggle swaps in Google's **Magenta.js** models (MusicVAE / MelodyRNN / DrumsRNN,
running on TensorFlow.js) for those who want true neural generation. These are
**lazy-loaded only on demand** (they fetch 20–45 MB of weights from Google's CDN),
so the default experience stays instant and dependency-free.

## Stack

- **Vite + React + TypeScript**
- **Tone.js** — synthesis + Web Audio scheduling, MIDI export via `@tonejs/midi`
- **Framer Motion** — UI animation
- **Web Audio API** — in-browser FFT analysis of uploaded tracks
- **@magenta/music** — optional deep-mode neural models
- Canvas visualisers: DAW-style piano-roll timeline, radar "DNA" chart, beat-reactive
  pixel character, audio-reactive matrix background

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production build → dist/
npm run preview  # serve the production build
```

No environment variables required.

## Project structure

```
src/
├── components/
│   ├── AudioReactiveBackground.tsx   matrix/particle canvas, beat-reactive
│   ├── CharacterDisplay.tsx          SVG pixel fighter, animates to the beat
│   ├── DNARadar.tsx                  radar chart of the current DNA vector
│   ├── GeneratorPanel.tsx            engine + control surface
│   ├── TrackTimeline.tsx             scrolling DAW piano-roll
│   └── AudioDropzone.tsx             drag-in track → in-browser analysis
├── lib/
│   ├── generative-engine.ts          in-house engine (Markov + harmony + Euclid)
│   ├── audio-analysis.ts             Web Audio FFT feature extraction
│   ├── taste-profile.ts              K-means clustering + conditioning
│   ├── magenta-engine.ts             optional Magenta deep mode
│   └── tone-synth.ts                 Tone.js synthesis + MIDI export
├── types.ts                          shared types
└── App.tsx
```

---

Built by [Tangeni Idhenga](https://www.tangeniidhenga.com).
