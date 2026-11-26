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
 │  • seven styles, and Groove handed to lib/groove                            │
 │  • arrangement: a layer at a time, up to 208 bars (272 as a DJ version)     │
 │  • polymetric percussion, on the grid with a hair of drift, tonic harmony   │
 │  • per-lane random streams, mix moves, piano-roll edits                     │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │ Track: notes, sections, automation, mix, kit
             ┌──────────────────────┼─────────────────────────────────┐
             ▼                      ▼                                 ▼
 ┌───────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
 │ lib/audio/player      │  │ lib/audio/render        │  │ UI: arrangement, roll,  │
 │ lookahead scheduler   │  │ OfflineAudioContext     │  │ mixer, neural heatmap,  │
 │ loop, seek, mixer,    │  │ WAV/AIFF/FLAC, stems,   │  │ master spectrum         │
 │ MIDI out + clock      │  │ MIDI, Live set,         │  │                         │
 │                       │  │ DJ tools, peak limiter  │  │                         │
 └───────────┬───────────┘  └────────────┬────────────┘  └─────────────────────────┘
             └─────────────┬─────────────┘
                           ▼
        lib/audio/voices + lib/audio/graph
        recorded samples → filters → real rooms → master bus
```

## Two composers

`generative-engine.ts` writes seven styles (Hypnotic, Percussive, Raw, Dub, Acid, Hard and
Bounce) and hands Groove to `lib/groove`:

- `families.ts` is data: each family's idea, kit, clap role and limits.
- `parts.ts` deals a combination from the seed and turns down weak ones. The sliders don't
  affect that choice, so they can't swap the take.
- `flow.ts` picks a layout, says whether a bar is in the beginning, middle, end or outro,
  and decides where the low end leaves before each hit.
- `compose.ts` writes the notes, and a gate on the rumble that shuts for each of those gaps.
- `dj.ts` wraps a finished take in 32 bars of drums at each end.

A Groove also carries an `endKit`, the family's other sounds, which the voices switch to from
the first drop. The switch is decided per note, so seeking and looping can't leave the wrong kit on.

The other styles share one writer, steered by a table in `STYLES`: which steps carry the bass,
the clap's role, the percussion loop lengths, the stab rhythm, how much of the riff model's
line to keep, and how much pump, space and rumble. Each has its own kit in `kits.ts`, which
also says how low its kick may be tuned (Bounce keeps its kick between 65 and 92 Hz in every key).

Both composers return the same `Track`, including its kit, so the player and the export don't
care which wrote it. Every voice plays on its step: two club records measured within 2 ms of
the grid, with no swing, so the only timing is a hair of seeded drift and one bright backbeat
layer 24 ms late.

## The signal path

`graph.ts` builds the same graph for the live `AudioContext` and the export's
`OfflineAudioContext`, and `voices.ts` plays notes through either. A bounce therefore
matches what you heard.

```
 kick ──► soft drive ──► box cut ──────────────────────────────────────────┐
 hats, claps ──► drive ──► width ──────────────────────────────────────────┤
 perc ──► drive ──► width ──► room, echo, hall ────────────────────────────┤
 808 kick ──► stone hall ──► drive ──► sub filter ──► mono ──► duck ───────┤
     └─ (Hard, Bounce) ──► mono ──► hard drive ──► 750 Hz–7 kHz ──► width ─┤
 bass: 808 tail + a recorded knock ──► soft drive ──────────────────► duck ┤
 stab, sequence, pad ──► bus -6 dB ──► high-pass 250 Hz ──► sweep ──► duck ┤
                                                                           ▼
   28 Hz high-pass ► mono below 170 Hz ► tone ► glue ► level ► soft ceiling ► -1 dBFS
```

Every hit is its own recording, repitched to the note and passed through a low-pass that
opens with velocity. The rumble follows the standard techno recipe: a long kick feeds a fully
wet reverb, the reverb is distorted, a low-pass leaves only the sub, and it ducks on every
kick, then swells back. The reverbs are convolutions with impulse responses measured in real rooms.

**Measured targets.** The master's tone (a gentle cut at 70 Hz, 400 Hz and 1.1 kHz, an air
shelf down at 8.5 kHz and a lift above 16 kHz), the rumble's level, the chord sends and the
master level were each set by running the same meters on reference records and on our
renders, band by band up to 22 kHz. Groove lands at about -8 LUFS, Hard about -5 and Bounce about -7.

**A low-pass that doesn't dull the top.** The browser's `BiquadFilterNode` uses the bilinear
transform, which squeezes the response to nothing at Nyquist: a 15 kHz low-pass at 48 kHz
takes about 9 dB more off at 19 kHz than an analog filter would. Every hat is filtered by
velocity, so that squeeze was most of the missing air. `matchedLowpass` in `master.ts` computes
Vicanek's matched second-order coefficients instead, and `voices.ts` runs them in an
`IIRFilterNode`, cached per 25 Hz of cutoff, falling back to the biquad where IIR filters
aren't supported. A test holds it within 1.2 dB of the analog curve up to 19 kHz.

**Mono-safe.** A `WaveShaperNode` hard-clips anything outside -1 to 1, so every saturator is
scaled to cover four times full scale and is flat at the ends, which a test checks. Width is
added only to the side signal above the low end, so the mono sum is the dry signal. The distorted
rumble in Hard and Bounce is folded to mono before the drive and only then widened a little, because
the hall's two sides, distorted apart, cancelled on a mono system. A compressor's automatic
makeup gain is worked out from the spec's formula and taken back off.

The tape echo sits at a dotted eighth with a high-pass, low-pass, saturation and a slow wow
on the delay time. Its saturator is gain-compensated: without that the loop gain passes 1,
and the echo rings forever.

## Export

`render.ts` plays the track into an `OfflineAudioContext`, queueing one second of notes at a
time, and measures the graph's own delay with a click so bar 1 is the first sample.

- **Native sample rates.** The sample bank decodes its recordings once per rate
  (`sampleBank.at(rate)`), so a 44.1 kHz export renders at 44.1 kHz from recordings decoded
  at that rate, rather than being rendered at 48 kHz and converted afterwards.
- **Loops** are rendered twice in a row and the second pass kept, so what rings over from
  the end is already at the start, as it will be when the loop repeats in a DAW.
- **Stems** keep the master's tone, which is linear, but skip its glue and ceiling, so
  together they rebuild the mix before the master's dynamics.
- **True-peak limiter** (`master.ts`). The soft ceiling only sees samples, but a converter or
  an MP3 encoder rebuilds what lies between them. After the render, a 4x interpolated peak
  envelope (Kaiser-windowed sinc, 32 taps) gives the gain each sample needs to stay under
  -1 dBTP. A backward pass eases the gain down over 1.5 ms before each peak and a forward pass
  releases it over 80 ms. A loop is treated as a ring, so the gain at its end already leads
  into its start. Stems aren't limited, so they still sum.
- **Files.** WAV, AIFF or FLAC at 24 bits or dithered 16, tagged with tempo, key, Camelot
  number and genre (RIFF INFO and ID3 in a WAV, ID3 in an AIFF, Vorbis comments in a FLAC). All
  three quantize through one function, so a FLAC decodes to exactly the WAV's samples. MIDI goes
  through `@tonejs/midi`. Zips are stored, not compressed: the audio inside is either PCM, which
  general-purpose compression barely shrinks, or FLAC, which is already compressed.
- **FLAC** (`flac.ts`), with no dependency. Blocks of 4,096 samples; each channel is predicted
  by whichever fixed polynomial (order 0 to 4) leaves the smallest error, and the error is
  Rice-coded in up to 256 partitions, each with its own parameter. A block of one repeated
  value (silence) is a single number. Stereo is stored as whichever of left/right, left/side,
  side/right or mid/side costs least. The MD5 of the audio is left unset, which the format
  allows. LPC prediction, as the reference encoder uses, would save a few percent more; fixed
  predictors keep the encoder short and fast. Tested by a decoder in the test suite that
  checks every CRC, and by ffmpeg decoding renders bit for bit.
- **Ableton Live set** (`ableton.ts`). A `.als` is gzipped XML. Live fills in its own defaults
  for anything a set leaves out, so the writer emits only what the take decides: the tempo,
  a locator per section, an audio track per stem and a MIDI track per part. Two things are
  not optional. Live needs at least one scene and, on every track, a clip slot for each
  scene; without them it loads the set and then crashes looking for the selected clip.
  Samples are referenced relative to the set, so the unzipped folder opens as it is. Each
  stem has two warp markers, its start and its end in beats, which places every beat because
  it was rendered at the set's tempo: Beats mode for drums, Tones for anything pitched, both
  available in Live Intro. Stems are FLAC, which brings a whole track's set from the better
  part of a gigabyte to a size a browser tab can hold. A loop's set holds the loop's stems,
  rendered to repeat seamlessly, and its notes; its clips loop, and so does the set's
  transport. The gzip uses the browser's own `CompressionStream`. It was tested
  by opening exports in Live 12 Intro and checking its log, its analysis files beside every
  stem, and that it stayed up.

## Why these choices

| Decision | Reason |
|---|---|
| **Recorded samples, not synthesis** | Real drum machines, metal and rooms carry detail that basic oscillators lack. Techno has always been built from machines and samples. |
| **Native Web Audio, no Tone.js** | One graph for live and export, sample-accurate ducking, convolution in both, and 345 KB less JavaScript. |
| **Lookahead scheduler** | Timers jitter, so events are queued a short way ahead on the audio clock. |
| **Chunked offline render** | Connected nodes cost time on every audio block, even before they play. Queueing one second at a time keeps exports fast. |
| **Mix targets measured on real records** | Ears drift and a laptop's speakers lie. The same meters on references and renders give numbers to match. |
| **A matched low-pass instead of the browser's** | The bilinear filter took the air off every hat. A matched filter got most of it back at no extra cost. |
| **Render at the output rate, not oversampled** | A 2x render gained 4.6 dB above 16 kHz but took 3.3 times as long, and the matched filter had already closed most of the gap. |
| **The limiter in TypeScript, after the render** | Offline, it sees every peak coming, so it can ease in early and measure between samples. A `DynamicsCompressor` can't do either. |
| **Recordings decoded per sample rate** | One conversion instead of two: before, the recordings were decoded to 48 kHz and the finished mix was then converted again to 44.1 kHz. |
| **A Live set written from scratch, not a template** | About 150 lines of code instead of a copy of Ableton's own file in the repo, and every element it writes is one Live writes itself, which a check against Live's bundled sets confirmed. |
| **Seeds separate from controls** | Sliders shape a take rather than re-rolling it, and a link reopens the exact track. |
| **Variation from a hash of the step** | The kick stays steady and other repeats vary, yet live playback, a seek and an export all get the same hits. |
| **Every mix move stores its start** | A ramp that relies on the current value lands differently offline and after a seek. |
| **Hand-written families in Groove** | Independent dice per part made competent loops with no idea in them. |
| **One random stream per lane** | Rewriting the bass leaves the drums and lead alone. |
| **Canvases read the audio clock** | The playhead moves without re-rendering React. |
| **Sample set loaded per kit** | The full pack is about 7 MB, and a kit only needs part of it. |
| **Split the corpus by artist** | Splitting by riff or file leaks near-copies of a song into the test set. |
| **GRU in NumPy, inference in TypeScript** | No ML runtime to ship or break, and the maths stays visible. |
| **Fallbacks at every network edge** | A missing sample gets a stand-in, and a missing model gets a Markov chain. |
| **DJ version wraps the track, it doesn't rewrite it** | The 208-bar body is the same notes moved 32 bars on; edits apply last, in the finished track's bars. |
| **MIDI timed from the audio clock** | `getOutputTimestamp()` maps audio time to `performance.now()`, so notes and clock land with the speakers, not with the timer that queued them. |
| **Your own samples by content hash** | Ids are a SHA-256 of the file, kept in IndexedDB; a share link drops them, since nobody else has the file. |
| **Taste: Beta posteriors and Thompson sampling** | Small enough to explain and test, learns from a handful of takes, and explores families it hasn't heard. Scored on later takes than it learned from. |

See the [model card](ml/MODEL_CARD.md) for the network and
[`public/samples/SOURCES.md`](public/samples/SOURCES.md) for every recording.
