# Architecture

Sound × AI is a 100% client-side app — no backend, no API. Everything below
runs in the browser (and the model is trained offline in NumPy, then shipped as
weights). Data flows left → right:

```
 ┌─────────────┐      ┌──────────────────────┐      ┌────────────────────────┐
 │  CONTROLS   │      │  AUDIO UPLOAD (opt.)  │      │   TRAINED GRU (offline) │
 │ style/tempo │      │  Web Audio decode     │      │   ml/train_gru.py       │
 │ energy/key… │      │   ├ RMS → energy      │      │   NumPy: fwd + BPTT     │
 └──────┬──────┘      │   ├ FFT → brightness  │      │   + Adam, loss 2.4→0.6  │
        │             │   ├ chroma → key      │      └───────────┬────────────┘
        │             │   └ onset flux → tempo│                  │ weights (43 KB)
        │             └───────────┬───────────┘                  ▼
        │                         │              public/model/riff-gru.json
        ▼                         ▼                              │
 ┌──────────────────────────────────────────┐    ┌──────────────▼─────────────┐
 │            AudioFeatures "DNA"            │    │   neural-engine.ts (TS)     │
 │  tempo · energy · valence · density ·     │    │   GRU forward pass + temp   │
 │  brightness · rootPitch · mode            │    │   sampling (no ML runtime)  │
 └──────────────────────┬────────────────────┘    └──────────────┬─────────────┘
                        │                                         │ lead riff
                        ▼                                         ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │                         generative-engine.ts                                │
 │  • GRU riff (Markov fallback)   • functional bass / 303 acid line           │
 │  • Euclidean + 4/4 drums        • stab / pad harmony                        │
 │  • tension/release arrangement (drive → full → breakdown → build → drop)    │
 │  • swing groove                 →  NoteEvent[]                              │
 └──────────────────────────────────────┬────────────────────────────────────┘
                                         │
            ┌────────────────────────────┼─────────────────────────────┐
            ▼                            ▼                              ▼
 ┌────────────────────┐   ┌──────────────────────────┐   ┌───────────────────────┐
 │  tone-synth.ts     │   │  TrackTimeline (canvas)   │   │  DNARadar / REZ-909 /  │
 │  voices + FX +     │   │  4-lane piano roll,       │   │  reactive background   │
 │  sidechain pump    │   │  click-to-edit            │   │  (visual layer)        │
 │  → live playback   │   └──────────────────────────┘   └───────────────────────┘
 │  → Tone.Offline ───┼──► WAV + per-stem render
 │  → MIDI export     │
 └────────────────────┘

 Shareable permalinks: the full config is encoded in the URL (share.ts) and
 re-seeds the controls on load — zero backend.
```

## Why these choices

| Decision | Reason |
|---|---|
| **Fully client-side** | Zero inference cost (the moat vs. server-side models), instant, private, deploys as a static site. |
| **GRU trained in NumPy, inference re-written in TS** | No heavy ML runtime to ship or break; makes the maths explicit; the model is ~43 KB. |
| **Markov fallback for the riff** | If the model fails to load, generation never breaks. |
| **Patterns + arrangement, not per-step randomness** | What separates "music" from "noise" — repetition and structure. |
| **Freeverb, NoiseSynth hats** | Algorithmic reverb + envelope-based hats render fast and correctly during offline export. |

See the [model card](ml/MODEL_CARD.md) for the network details.
