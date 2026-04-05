# Sound × AI — Musical DNA Generator

> Generative audio that learns from your Spotify listening history and synthesises original tracks in-browser using machine learning.

![Sound × AI](https://img.shields.io/badge/built%20with-Magenta.js%20%2B%20Tone.js-b8ff2c?style=flat-square&labelColor=030903)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-b8ff2c?style=flat-square&labelColor=030903)
![React](https://img.shields.io/badge/React-18-b8ff2c?style=flat-square&labelColor=030903)
![Vercel](https://img.shields.io/badge/deployed%20on-Vercel-b8ff2c?style=flat-square&labelColor=030903)

---

## What it does

Sound × AI analyses your Spotify listening history to build a **Musical DNA profile** — a weighted statistical model of your taste across tempo, energy, valence, danceability, and acousticness. That profile then conditions three separate ML models to synthesise original music that reflects how you actually listen, not just what genre you selected.

The generation is entirely **in-browser** via TensorFlow.js. No audio is sent to a server.

---

## ML architecture

```
Spotify API ──► Listening history ──► Audio features
                                           │
                                    Musical DNA profile
                                    (K-means, k=3 clusters)
                                           │
                        ┌──────────────────┼──────────────────┐
                        ▼                  ▼                  ▼
                   MelodyRNN          MusicVAE           DrumRNN
               Melodic sequences   Latent space      Rhythmic patterns
               (LSTM, Magenta.js)  interpolation   (danceability seed)
                        │                  │                  │
                        └──────────────────┴──────────────────┘
                                           │
                                   Tone.js synthesis
                              (PolySynth + effects chain)
                                           │
                                     Audio output
                                    + MIDI export
```

**MelodyRNN** — an LSTM that continues a pentatonic seed sequence. Temperature is driven by your energy + valence averages: high energy listeners get more exploratory melodic output.

**MusicVAE** — a variational autoencoder that samples two points in latent melody space and interpolates four steps between them. The latent bias vector is nudged by your taste profile's `[energy, valence]` centroid.

**DrumRNN** — generates rhythmic patterns from a kick/snare/hat seed. Pattern density (1–4) is seeded directly from your mean danceability score.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI framework | React 18 + TypeScript + Vite |
| ML models | `@magenta/music` (MelodyRNN, MusicVAE, DrumRNN) |
| Audio synthesis | `tone` v14 (PolySynth, MembraneSynth, MetalSynth) |
| MIDI export | `@tonejs/midi` |
| Animation | Framer Motion |
| Spotify data | Spotify Web API (via Vercel serverless function) |
| Deployment | Vercel (frontend + serverless API) |

---

## Features

- **Musical DNA radar** — animated spider chart showing your real-time taste profile across 5 audio dimensions
- **Beat-reactive pixel fighter** — SVG character with 5 animation states (idle, attack, crouch, jump, victory) driven by beat detection
- **Audio-reactive background** — sparse matrix rain + drifting node network that responds to energy, valence and tempo
- **DAW-style piano roll** — scrolling track timeline with melody, chords and drum lanes
- **Live Spotify card** — now playing / last played with real-time progress bar
- **MIDI export** — download generated sequences as `.mid` for use in any DAW

---

## Project structure

```
sound-x-ai/
├── api/
│   └── spotify.ts          # Vercel serverless — all Spotify API routes
├── src/
│   ├── components/
│   │   ├── AudioReactiveBackground.tsx   # Canvas animation layer
│   │   ├── CharacterDisplay.tsx          # SVG pixel fighter
│   │   ├── DNARadar.tsx                  # Radar chart canvas
│   │   ├── GeneratorPanel.tsx            # Main generation UI
│   │   ├── NowPlaying.tsx                # Spotify now playing card
│   │   └── TrackTimeline.tsx             # Piano roll visualiser
│   ├── lib/
│   │   ├── spotify.ts                    # Client-side Spotify data layer
│   │   ├── taste-profile.ts              # K-means clustering + DNA profile
│   │   ├── magenta-engine.ts             # MelodyRNN / MusicVAE / DrumRNN
│   │   └── tone-synth.ts                 # Synthesis + playback + MIDI export
│   ├── types.ts                          # Shared TypeScript interfaces
│   ├── App.tsx                           # Root component + state
│   ├── main.tsx                          # Entry point
│   └── index.css                         # Global styles + CSS variables
├── index.html
├── vite.config.ts
└── vercel.json
```

---

## Local development

### Prerequisites

- Node.js 18+
- A [Spotify Developer App](https://developer.spotify.com/dashboard) with the following scopes:
  - `user-read-currently-playing`
  - `user-read-recently-played`
  - `user-top-read`

### 1. Clone and install

```bash
git clone https://github.com/yourusername/sound-x-ai.git
cd sound-x-ai
npm install
```

### 2. Get your Spotify refresh token

Add these redirect URIs to your Spotify app in the developer dashboard:
```
https://your-vercel-url.vercel.app/api/spotify?action=callback
http://localhost:3000/api/spotify?action=callback
```

Deploy to Vercel first (or run `vercel dev` locally), then visit:
```
https://your-url/api/spotify?action=login
```

Authorise with your Spotify account. Copy the `refresh_token` from the JSON response.

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `.env.local`:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REFRESH_TOKEN=your_refresh_token
```

### 4. Run

```bash
# With Spotify API (runs Vite + Vercel serverless together)
npx vercel dev

# UI only — no Spotify credentials needed, Magenta generation still works
npm run dev
```

Open `http://localhost:3000` (vercel dev) or `http://localhost:5173` (vite only).

> **Note:** On first Generate, the browser downloads Magenta model weights from Google's CDN (~20–45 MB depending on model). This is cached after the first load. The status log in the generator panel shows download progress.

---

## Deploying to Vercel

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Add environment variables via dashboard or CLI
vercel env add SPOTIFY_CLIENT_ID
vercel env add SPOTIFY_CLIENT_SECRET
vercel env add SPOTIFY_REFRESH_TOKEN
```

Vercel automatically detects the `api/` folder and deploys `spotify.ts` as a serverless function. No additional configuration required.

---

## Environment variables

| Variable | Description |
|---|---|
| `SPOTIFY_CLIENT_ID` | From your Spotify Developer App |
| `SPOTIFY_CLIENT_SECRET` | From your Spotify Developer App |
| `SPOTIFY_REFRESH_TOKEN` | Generated via the `/api/spotify?action=login` flow |

Never commit `.env.local` to git — it's already in `.gitignore`.

---

## How the taste profiler works

`src/lib/taste-profile.ts` runs a sparse K-means (k=3) over your listening history with hand-picked initial centroids:

| Cluster | Tempo | Energy | Acousticness |
|---|---|---|---|
| HIGH ENERGY | ~140 BPM | 0.85 | 0.05 |
| CHILL | ~90 BPM | 0.35 | 0.65 |
| BALANCED | ~115 BPM | 0.60 | 0.25 |

The dominant cluster + mean feature vector are then mapped to Magenta conditioning parameters:

- **MelodyRNN temperature** `= 0.6 + energy×0.4 + valence×0.2 − acousticness×0.2`
- **DrumRNN density** `= 1 + danceability×3` (clamped 1–4)
- **MusicVAE latent bias** `= [(energy−0.5)×2, (valence−0.5)×2]`
- **Synth BPM** `= mean_tempo×0.6 + cluster_tempo×0.4`
- **Filter brightness** `= valence×0.6 + (1−acousticness)×0.4`

---

## Licence

MIT
