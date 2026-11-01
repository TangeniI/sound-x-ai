# Architecture

Sound × AI is a fully client-side app with no backend and no API keys. The model is
trained offline in NumPy and shipped as weights. Everything else runs in the browser.

```
 ┌─────────────┐      ┌──────────────────────┐      ┌─────────────────────────┐
 │  CONTROLS   │      │  AUDIO FILE (opt.)    │      │  TRAINED GRU (offline)  │
 │ style/tempo │◄─────│  decode, then         │      │  ml/train_gru.py        │
 │ energy/key… │ sets │   ├ RMS → energy      │      │  NumPy: forward, BPTT,  │
 │ seed = take │      │   ├ chroma → key      │      │  Adam on 9,248 riffs    │
 └──────┬──────┘      │   └ onset comb → BPM  │      └────────────┬────────────┘
        │             └───────────────────────┘                   │ weights
        │                                                         ▼
        │                                        ┌─────────────────────────────┐
        │                                        │  neural-engine.ts           │
        │                                        │  forward pass + sampling    │
        │                                        └────────────┬────────────────┘
        ▼                                                     │ riff + probabilities
 ┌────────────────────────────────────────────────────────────▼────────────────┐
 │                           generative-engine.ts                              │
 │  • arrangement: intro, groove, riff, break, build, drop, outro              │
 │  • 4/4 drums, Euclidean percussion, style basslines, parallel chords        │
 │  • per-lane random streams, mix moves, piano-roll edits                     │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │ Track: notes, sections, automation, mix
            ┌───────────────────────┼───────────────────────────┐
            ▼                       ▼                           ▼
 ┌────────────────────┐  ┌───────────────────────┐   ┌────────────────────────┐
 │ lib/audio/player   │  │ lib/audio/render      │   │ UI: arrangement, roll, │
 │ lookahead scheduler│  │ OfflineAudioContext   │   │ mixer, neural heatmap, │
 │ loop, seek, mixer  │  │ WAV, stems, MIDI      │   │ DNA radar, REZ-909     │
 └─────────┬──────────┘  └──────────┬────────────┘   └────────────────────────┘
           └───────────┬────────────┘
                       ▼
        lib/audio/voices + lib/audio/graph
        recorded samples → filters → real rooms → master bus
```

## The signal path

`graph.ts` builds the same graph for the live `AudioContext` and the export's
`OfflineAudioContext`, and `voices.ts` plays notes through either. A bounce therefore
matches what you heard.

```
 kick ──────────────► drum bus (saturation, 55 Hz shelf) ───────────────┐
 hats, claps ───────►                                                   │
 808 kick ──► stone hall ──► distortion ──► 170 Hz low-pass ──► mono ──► duck ──┤
 bass ──► saturation ──────────────────────────────────────────────► duck ──┤
 stab, lead, pad ──► arrangement filter ───────────────────────────► duck ──┤
        └──► tape echo, hall (gated by each channel's mute) ───────► duck ──┤
                                                                            ▼
                                   glue compressor ► soft clip ► limiter ► out
```

The rumble follows the standard techno recipe: a long kick feeds a fully wet reverb, the
reverb is distorted, a low-pass leaves only the sub, and it ducks on every kick, then swells
back. The reverbs are convolutions with impulse responses measured in real rooms.

The tape echo sits at a dotted eighth with a high-pass, low-pass, saturation and a slow wow
on the delay time. Its saturator is gain-compensated: without that the loop gain passes 1,
and the echo rings forever.

## Why these choices

| Decision | Reason |
|---|---|
| **Recorded samples, not synthesis** | Real drum machines, metal and rooms carry detail that basic oscillators lack. Techno has always been built from machines and samples. |
| **Native Web Audio, no Tone.js** | One graph for live and export, sample-accurate ducking, convolution in both, and 345 KB less JavaScript. |
| **Lookahead scheduler** | Timers jitter, so events are queued a short way ahead on the audio clock. |
| **Chunked offline render** | Connected nodes cost time on every audio block, even before they play. Queueing one second at a time keeps exports fast. |
| **Seeds separate from controls** | Sliders shape a take rather than re-rolling it, and a link reopens the exact track. |
| **One random stream per lane** | Rewriting the bass leaves the drums and lead alone. |
| **Canvases read the audio clock** | The playhead moves without re-rendering React. |
| **Sample set loaded per style** | The full pack is 6 MB, and a style only needs part of it. |
| **Split the corpus by artist** | Splitting by riff or file leaks near-copies of a song into the test set. |
| **GRU in NumPy, inference in TypeScript** | No ML runtime to ship or break, and the maths stays visible. |
| **Fallbacks at every network edge** | A missing sample gets a stand-in, and a missing model gets a Markov chain. |

See the [model card](ml/MODEL_CARD.md) for the network and
[`public/samples/SOURCES.md`](public/samples/SOURCES.md) for every recording.
