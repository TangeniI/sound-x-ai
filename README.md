# Sound × AI

![CI](https://github.com/TangeniI/sound-x-ai/actions/workflows/ci.yml/badge.svg)
![React](https://img.shields.io/badge/React-19-149eca)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![ML](https://img.shields.io/badge/model-GRU%20(from%20scratch)-b8ff2c)
![backend](https://img.shields.io/badge/backend-none-555)

**[▶ Open the live studio](https://sound-x-ai.vercel.app)**

A techno studio that runs entirely in your browser. A neural network trained on real riffs
writes the music, and it plays through recordings of real drum machines, metal, keys and
rooms. There's no backend, no API key and no account.

**In short:** I trained a GRU from scratch in NumPy, with hand-written back-propagation and
Adam, on 13,502 riffs from real MIDI. On artists it never saw, it scores 1.24 nats against
1.55 for the best n-gram baseline. The forward pass is re-implemented in TypeScript and
checked against Python by a test. A custom Web Audio engine then plays the result through
45 recordings and 2 measured rooms, with the same signal path for live playback and export.

## What you can do

- **Press play.** A full track is ready: intro, groove, break, build, drop and outro.
- **Move a slider.** Energy, mood and density change the music as it plays, without replacing it.
- **Rewrite one part.** Mute, solo or re-roll each lane on its own.
- **Edit notes.** Click the piano roll to add or remove them.
- **Steer the model.** Watch its note probabilities, then hold a note, and it rewrites what follows.
- **Match a track.** Drop in an audio file to set the tempo, key, energy and mood. Nothing leaves your device.
- **Take it with you.** Export a WAV, six stems or MIDI, or share a link that reopens the exact track.

## How it sounds real

Techno comes from machines, samples and rooms, so that's what this uses.

| Layer | Source |
|---|---|
| **Drums** | Original TR-808 recordings, Roland TR-8 hardware, hand claps |
| **Metal** | A real anvil, brake drum and gong |
| **Chords and pads** | Sampled chords repitched as one block, as on a hardware sampler, including pads from [The Black Dog](https://theblackdogma.com) |
| **Keys** | Yamaha TX81Z hardware |
| **Space** | Convolution reverb measured in Oxford's medieval Divinity School |
| **Rumble** | A long 808 kick through that hall, distorted, filtered to the sub and ducked on every hit |
| **Echo** | A dub tape delay at a dotted eighth, with filtered, saturated repeats and wow |
| **Texture** | Vinyl noise under everything, and risers made from a gong and cymbal played backwards |

The kick is tuned to the key, and the low end stays mono. Each style has its own kit. Every
recording is CC0 or CC BY: see [SOURCES.md](public/samples/SOURCES.md).

## The model

| Model | NLL on unseen artists (nats, lower is better) |
|---|---|
| Random guess | 3.18 |
| Bigram | 1.70 |
| Trigram (best baseline) | 1.55 |
| **GRU** | **1.24** |

The first version trained on 20 hand-written motifs. A held-out test showed it scored worse
than random guessing on new material, so I rebuilt the pipeline: real data, a split by
artist, early stopping and baselines. The [model card](ml/MODEL_CARD.md) has the method and
its limitations.

## Audio analysis

[`audio-analysis.ts`](src/lib/audio-analysis.ts) is plain DSP with no ML library:

- **Tempo:** a low-weighted onset envelope scored with a comb filter at 1, 2, 4 and 8 beats, between envelope frames
- **Key:** peak-picked chroma from a long FFT, correlated with Krumhansl-Kessler key profiles
- **Energy and brightness:** RMS loudness and spectral centroid

Tempo was exact on 8 of 8 of the app's own renders and within 1 BPM on every test pulse from
120 to 145 BPM. Key detection is much weaker on dense, drum-heavy mixes, at 5 of 12 on those
renders, so the app labels it an estimate and you can change it in one click.

## Stack

Vite, React, TypeScript, the native Web Audio API, Canvas, and Framer Motion for the
droid. `@tonejs/midi` writes MIDI files. Training uses only NumPy.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and signal path.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 43 tests
npm run build    # typecheck + production build
```

## Project structure

```
src/
├── App.tsx                   layout and keyboard shortcuts
├── hooks/useStudio.ts        all studio state and actions
├── components/
│   ├── TrackTimeline.tsx     arrangement, piano roll, mixer strips
│   ├── NeuralPanel.tsx       live view of the riff model
│   ├── Controls.tsx          style, sliders, length, key
│   ├── Transport.tsx         play, position, loop, export
│   └── AudioDropzone, DNARadar, CharacterDisplay, AudioReactiveBackground, Credits
└── lib/
    ├── generative-engine.ts  writes the track
    ├── neural-engine.ts      GRU forward pass and sampling
    ├── audio-analysis.ts     tempo and key detection
    ├── share.ts              permalinks
    └── audio/                samples, kits, graph, voices, player, render
ml/                           corpus builder, trainer, results, model card
scripts/build_samples.py      builds the sample pack
public/samples/               the recordings and their credits
```

---

Built by [Tangeni Idhenga](https://www.tangeniidhenga.com).
