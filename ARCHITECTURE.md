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
 │  • arrangement: a layer at a time, up to 176 bars                           │
 │  • polymetric percussion, swing and feel per voice, tonic harmony           │
 │  • per-lane random streams, mix moves, piano-roll edits                     │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │ Track: notes, sections, automation, mix
            ┌───────────────────────┼───────────────────────────┐
            ▼                       ▼                           ▼
 ┌────────────────────┐  ┌───────────────────────┐   ┌────────────────────────┐
 │ lib/audio/player   │  │ lib/audio/render      │   │ UI: arrangement, roll, │
 │ lookahead scheduler│  │ OfflineAudioContext   │   │ mixer, neural heatmap, │
 │ loop, seek, mixer, │  │ WAV/AIFF, stems, MIDI │   │ master spectrum        │
 │ MIDI out + clock   │  │ DJ tools, tags        │   │                        │
 └─────────┬──────────┘  └──────────┬────────────┘   └────────────────────────┘
           └───────────┬────────────┘
                       ▼
        lib/audio/voices + lib/audio/graph
        recorded samples → filters → real rooms → master bus
```

## Two composers

`generative-engine.ts` writes five styles and hands Groove to `lib/groove`:

- `families.ts` is data: each family's idea, kit, clap role and limits.
- `parts.ts` deals a combination from the seed and turns down weak ones. The sliders don't
  affect that choice, so they can't swap the take.
- `flow.ts` picks a layout, says whether a bar is in the beginning, middle, end or outro,
  and decides where the low end leaves before each hit.
- `compose.ts` writes the notes, and a gate on the rumble that shuts for each of those gaps.

A Groove also carries an `endKit`, the family's other sounds, which the voices switch to from
the first drop. The switch is decided per note, so seeking and looping can't leave the wrong kit on.

Both return the same `Track`, including its kit, so the player and the export don't care which wrote it.

Exports measure the graph's own delay with a click and trim it, so bar 1 is the first sample.

## The signal path

`graph.ts` builds the same graph for the live `AudioContext` and the export's
`OfflineAudioContext`, and `voices.ts` plays notes through either. A bounce therefore
matches what you heard.

```
 kick ──► soft drive ───────────────────────────────────────────────┐
 hats, claps ──► drive ──► width ───────────────────────────────────┤
 perc ──► drive ──► width ──► room, echo, hall ─────────────────────┤
 808 kick ──► stone hall ──► drive ──► sub filter ──► mono ──► duck ┤
 bass: 808 tail + a recorded knock ──► soft drive ───────────► duck ┤
 stab, sequence, pad ──► sweep filter ──► width ─────────────► duck ┤
                                                                    ▼
           mono below 170 Hz ► tone ► glue ► soft ceiling ► -2 dBFS out
```

The rumble follows the standard techno recipe: a long kick feeds a fully wet reverb, the
reverb is distorted, a low-pass leaves only the sub, and it ducks on every kick, then swells
back. The reverbs are convolutions with impulse responses measured in real rooms.

A `WaveShaperNode` hard-clips anything outside -1 to 1. Every saturator here is scaled so
its curve covers four times full scale and is flat at the ends, which a test checks. Width
is added only to the side signal, so the mono sum is the dry signal. A compressor's automatic
makeup gain is worked out from the spec's formula and taken back off.

Stems keep the master's tone (the high-pass, mono lows and EQ) but skip its glue and ceiling,
so together they rebuild the mix before compression.

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
| **Variation from a hash of the step** | The kick stays steady and other repeats vary, yet live playback, a seek and an export all get the same hits. |
| **Every mix move stores its start** | A ramp that relies on the current value lands differently offline and after a seek. |
| **Hand-written families in Groove** | Independent dice per part made competent loops with no idea in them. |
| **One random stream per lane** | Rewriting the bass leaves the drums and lead alone. |
| **Canvases read the audio clock** | The playhead moves without re-rendering React. |
| **Sample set loaded per kit** | The full pack is 6 MB, and a kit only needs part of it. |
| **Split the corpus by artist** | Splitting by riff or file leaks near-copies of a song into the test set. |
| **GRU in NumPy, inference in TypeScript** | No ML runtime to ship or break, and the maths stays visible. |
| **Fallbacks at every network edge** | A missing sample gets a stand-in, and a missing model gets a Markov chain. |
| **DJ version wraps the track, it doesn't rewrite it** | The 176-bar body is the same notes moved 32 bars on; edits apply last, in the finished track's bars. |
| **MIDI timed from the audio clock** | `getOutputTimestamp()` maps audio time to `performance.now()`, so notes and clock land with the speakers, not with the timer that queued them. |
| **Your own samples by content hash** | Ids are a SHA-256 of the file, kept in IndexedDB; a share link drops them, since nobody else has the file. |
| **Taste: Beta posteriors and Thompson sampling** | Small enough to explain and test, learns from a handful of takes, and explores families it hasn't heard. Scored on later takes than it learned from. |

See the [model card](ml/MODEL_CARD.md) for the network and
[`public/samples/SOURCES.md`](public/samples/SOURCES.md) for every recording.
