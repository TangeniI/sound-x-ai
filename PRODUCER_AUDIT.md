# Producer and DJ audit: Sound × AI

22 November 2026, second audit. This covers the local, uncommitted version, after steps 1 and 2
of the first audit were built. The live site is still the older version. No code was changed
for this audit.

## The verdict

**Would a producer use it?** Not yet as a tool, but now for the right reason. The first audit
found nothing worth keeping and no safe way to keep it. Both are now fixed:

- Groove takes have one idea, a wind-down before the drop and a beginning, middle and end.
- Exports land on the grid and an edit can't be lost.

What's missing is the step from "I like this" to "it's in my project and it's mine". That
means bar-exact loop exports, the kick on its own stem, locks, sound choice and some way into
the DAW beyond dragging a file.

**Would a DJ play it?** No. The tracks have no mixable intro: zero bars of drums alone at the
start, 2–4 at the end, 5:06 at most. Every store and many DJs are also turning away from
generated tracks (see "The market"). A DJ's way in is as a tool for making DJ tools and loops,
not as a source of finished tracks.

**The one thing still unproven** is whether the music is good. Your blind vote on the 20
tracks is the gate. Everything below assumes it passes. If it doesn't, the music gets fixed
before any of this.

## How this was checked

- Read the current composer, export, history and every screen.
- Generated 120 Groove tracks per length to measure intros, outros and lengths.
- Used the measurements taken while building steps 1 and 2, which are listed under "What works".
- A research pass on competing tools, producer surveys, DJ file needs, scaling routes and
  store policies on AI music.
  - Only two of those pages were opened in full. The rest were read as search summaries.
  - Check prices on vendors' own pages before quoting them.

Nothing here was judged by ear, and no producer or DJ was interviewed.

## What works

| What | Evidence |
|---|---|
| Exports on the grid | The kick starts 0–0.5 ms from the grid. Before the fix: stems 24–26 ms late, the mix about 34 ms. |
| Nothing gets lost | Undo, redo, and the last 30 takes survive a reload. Undoing and then changing something keeps what was undone. |
| Each take has an idea | 12 families, each built around one lead idea that sits 8–13 dB under the drums and can be heard. |
| Takes differ | Two takes from different families share a median 15% of their hits. Before families: 58–67%. |
| The track moves | Beginning and end share about 22% of their hits, down from about 55%. At the default length, the typical take never runs more than eight bars without a change. |
| The drop hits | The low end leaves before each drop and returns within 0.3 dB, exactly on the one. |
| Opens on the good part | Randomise starts on the eight bars after the first drop, not on bar 1. |
| Honest sources | All 47 recordings are CC0 or CC BY, credited in the app. |
| No barrier | Free, no account, nothing leaves the browser, and links reopen the exact track. |

Nobody else sells this. The research found no techno-specific generator that writes an
arrangement with an idea, wind-downs and drops. Competitors generate drum patterns with a genre
preset. That structure is the product's real edge, and the rest of this plan protects it.

## What's bad, for a producer

| Problem | Why it matters | Severity |
|---|---|---|
| No loop export. Every audio export is the whole track plus a 3-second tail (`render.ts:17`) | A producer wants the eight bars they heard, trimmed to the bar, to drop on a track | Critical |
| The kick shares a stem with claps, hats and percussion (`render.ts:20`) | Replacing or processing the kick is the first thing they do | Critical |
| No locks. Randomise replaces every part | They can't keep a drum groove and try other ideas over it | High |
| An edit changes one note in one bar | Changing a pattern means a click in every bar it plays | High |
| No faders. Mute and solo only | They can't balance parts before exporting | High |
| No sound choice and no own samples | 4 kicks, 3 claps and no recorded snare. A producer recognises stock 808s and 909s and wants their own | High |
| Loops of eight bars or the whole track only | Techno is often written in 4-bar loops | Medium |
| 16-bit WAV at 48 kHz, stems as six separate downloads | Studios expect 24-bit, and releases are commonly 44.1 kHz | Medium |
| No statement on what may be done with exports | Releases are being screened for AI. Producers expect a Splice-style licence statement | Medium |
| Groove shows a large "model not used" panel | It reads as a portfolio demo, not a tool | Low |
| No way into the DAW but files | No MIDI out, no clock, no plugin | Strategic, see "How to scale" |

The other five styles haven't had the Groove work. The first audit's findings still apply to
them: ideas buried 16–34 dB under the drums, one kit each, and takes that reshuffle the same
parts. Randomise already avoids them, but anyone who clicks Hypnotic or Dub hears the old engine.

## What's bad, for a DJ

- **No drum intro:** the idea plays from bar 1, so there are 0 bars of drums alone to mix in on.
  DJ guides ask for 16–32 bars of sparse intro and a matching outro, in multiples of eight.
- **Too short:** the longest track is 5:06. Techno releases commonly run six to eight minutes.
- **Too short at the end:** an outro of 2–4 bars of drums alone gives no room to mix out.
- **Files:** WAV with no key or BPM tags, and no AIFF, which DJ software tags more reliably.
- **Distinctiveness:** unproven until the blind vote.
- **Stores:**
  - Bandcamp (January 2026) bans music made wholly or largely by AI.
  - Beatport (August 2026) withholds fully or mostly generated tracks and tags AI-assisted ones.
  - Beatport cites a user survey in which 60% of users would not play AI tracks in a set.
  - A full Sound × AI track released unchanged would likely count as generated (an inference,
    not a ruling). A DJ can't safely release these, and many won't play them.

## The market

- **Drum and loop generators are crowded.** Each offers genre steering or its own samples,
  locks, per-part randomising, and audio and MIDI export by drag and drop:
  - Audiomodern Playbeat 4: plugin, €69–89, 35 genres including techno.
  - XLN XO: about $130–150.
  - DrumNet 2.
  - Splice's Create mode.
  - Ableton Live 12's own MIDI generators.
- **Producers use AI for chores, not for writing.**
  - Sonarworks 2026 (n=1,194): 58% use AI for audio restoration, 21% for composition.
    The top objection, from 77%, is lost originality.
  - Tracklib: only 6% use fully generative tools, and 83% want AI use disclosed.
  - LANDR: song generators appeal to about half of beginners but a quarter of professionals.
- **What sells is assistance that leaves the result theirs:** ideas, patterns and MIDI
  they finish themselves. That's what Sound × AI should be.

## What to build next

The order matters. Each step has a test that says it's done.

### Step 0. Pass the blind vote

Keep 14 of 20 and tell them apart. If it fails, fix the families that lost votes before
anything else.

### Step 1. From idea to DAW in under two minutes (medium)

1. **Loop export:** the 4, 8 or 16 bars you're hearing, cut to the bar with no tail, 24-bit.
   Choose 44.1 or 48 kHz.
2. **Stems:** kick, clap and snare, hats and ride, percussion, low end, idea and FX. All in
   one zip, all the same length.
3. **Locks** on each part, kept through Randomise and New take.
4. **Pattern edits:** a click edits that note in every repeat of the pattern, with a key to
   edit one bar only.
5. **A fader per part,** saved with the take.
6. **A 4-bar loop.**
7. **A licence line under Export:**
   - The recordings are CC0 or CC BY, and the output is yours to use commercially.
   - Many stores screen tracks made wholly by generators, so finish the track yourself.
   - Keep it factual. It isn't legal advice.
8. **Groove panel:** replace the model panel with a short "About the model" link.

**Done when:** a producer who has never seen it gets a loop playing in time in their DAW in
under two minutes, without help.

### Step 2. Make it theirs (medium)

1. **Swap sounds:** each voice can use the family's other recordings, a list of alternatives,
   or one of your own.
2. **Your own samples:** dropped in and kept in the browser, never uploaded.
3. **Snares:** add recorded snares, which the families now fake by layering. Downloading new
   samples needs your OK and a licence check.

**Done when:** a take can contain none of the stock recordings.

### Step 3. Leave the browser (large, and the main way to scale)

The composer is pure TypeScript and already separate from the audio: `lib/groove` writes notes,
and `lib/audio` plays them. That's what makes the following cheap compared with a rewrite.

1. **MIDI out and clock from the browser (Web MIDI).** The families play the producer's own
   drum machine, synth or DAW instruments.
   - Works in Chrome, Edge and Firefox, not Safari.
   - The sound is then entirely theirs, which answers the originality objection.
2. **A Max for Live MIDI Generator for Ableton Live 12.**
   - Live 12 accepts third-party generators in the clip view.
   - Pick a family, press generate, and a groove is written straight into a clip, with locks
     and a seed.
   - Port `lib/groove` to Max's JavaScript.
   - Max for Live devices sell through maxforlive.com, Gumroad, Isotonik and Attack Magazine's
     store. One forum post puts typical prices at €15–25.
   - It needs Live Suite, or Standard with Max for Live.
3. **Later, if Step 3.2 sells:** a VST/AU MIDI plugin.
   - JUCE 8 can host the same code in a WebView.
   - Developers report WebKit crashes in some DAWs, so it's the riskiest route.
   - CLAP reaches only Bitwig and REAPER for now.

Don't build Ableton Link in the browser: it has no official browser version.

### Step 4. The other styles and DJ versions (large)

1. Put each style through the same family process and blind vote. Cut any that fail.
2. Name styles the way stores do. Beatport now splits techno into Peak Time and
   Raw / Deep / Hypnotic.
3. **DJ mode:**
   - Six to eight minutes.
   - 16 or 32 bars of drums alone at each end, with sections in multiples of eight.
   - 44.1 kHz 24-bit WAV or AIFF, with BPM and key (including Camelot) tagged.
4. **DJ tools:** drum-only grooves, loops and builds for layering in a set. These are
   sounds and patterns, not finished AI tracks.

### Step 5. Make the AI earn its name (large, and the strongest portfolio story)

Groove uses no machine learning, and the README says so. The honest way to put AI back:

1. Record keeps, skips and exports, opt-in and on the device first.
2. Learn which family settings and changes people keep, and steer Randomise towards them.
3. Report it like the GRU: a held-out test set, a baseline, and blind votes before and after.

That is preference learning from real use, which reads better to an employer than a generic
generator. It needs users first, so it comes after Steps 1–3.

## How the business could work

- **The web app stays free, with no account.** It's the portfolio piece and the shop window.
  Hosting is static, so it costs next to nothing at any traffic.
- **Paid:**
  - A Max for Live device, one-off. Competing plugins sell for €69–149 one-off.
  - Later, family packs.
  - Don't start a subscription. Splice, Loopcloud and Output own that model at $8–40 a month.
- **Avoid a backend** until Step 5 needs one.
- **Measure what matters:** how many visitors export something, and how many come back
  within a week. That is how you'd know it competes.

## What not to do

- Don't release or market full tracks as music. Stores are rejecting them, and producers
  don't want them.
- Don't add styles, mastering or visual redesigns before Steps 0–1.
- Don't take on Playbeat or XO on drum generation. Compete on what they don't do:
  techno-specific ideas and arrangement.
- Don't promise Ableton Link, Safari MIDI or plugin formats before they're proven.

## Sources

Most were read as search summaries. "Opened" marks the two pages read in full.

- [Sonarworks producer survey 2026](https://www.sonarworks.com/blog/research/future-music-production-human-producer-survey-2026) (opened)
- [Attack Magazine: Playbeat 4 review](https://www.attackmagazine.com/reviews/gear-software/playbeat-4-ai-driven-sequencing-done-right/) (opened)
- [Tracklib survey summary](https://tracklib_1.prowly.com/435412-global-study-reveals-music-producers-are-rejecting-ai-only-6-use-generative-tools) (the page was unavailable; figures from search results)
- [LANDR AI survey](https://landr.com/ai)
- [XO export panel](https://support.xlnaudio.com/hc/en-us/articles/16920459331485-Export-WAV-MIDI-Panel)
- [Ableton Live 12 manual: MIDI Tools](https://www.ableton.com/en/live-manual/12/midi-tools/)
- [Magenta Studio 2.0](https://magenta.tensorflow.org/studio-announce-2)
- [Splice Create stacks](https://www.musicradar.com/news/splice-create-stacks)
- [Splice sounds licensing FAQ](https://intercom.help/splice-b7a2d5b83f2e/en/articles/8652642-splice-sounds-licensing-faq)
- [Suno Studio 2.0](https://musicbusinessworldwide.com/suno-launches-studio-2-0-with-midi-support)
- [Mixed In Key: DJ-friendly arrangement](https://mixedinkey.com/?p=5367)
- [Beatport release file requirements](https://greenroomsupport.beatport.com/hc/en-us/articles/9444795955732-Create-New-Releases)
- [Beatport's new techno categories](https://www.beatportal.com/articles/440314-beatport-is-expanding-its-techno-categories)
- [Bandcamp: keeping Bandcamp human](https://blog.bandcamp.com/2026/01/13/keeping-bandcamp-human/)
- [DJ Mag: Beatport and generated tracks](https://djmag.com/news/beatport-banning-fully-ai-generated-tracks)
- [Can I use: Web MIDI](https://caniuse.com/midi)
- [Ableton Link](https://ableton.github.io/link)
- [Web Audio Modules](https://github.com/webaudiomodules/api)
- [JUCE forum: WebView plugin crash](https://forum.juce.com/t/webkit-processthrottler-crash-in-juce-8-webview-plugin-macos/68055)
- [Attack Magazine Max for Live store](https://www.attackmagazine.com/?p=129317)
