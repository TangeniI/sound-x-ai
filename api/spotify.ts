/**
 * api/spotify.ts  — Vercel Serverless Function
 *
 * Handles all Spotify API routes for Sound×AI.
 *
 * Routes (via ?action=):
 *   login                              → OAuth redirect (one-time setup)
 *   callback?code=                     → Token exchange, prints refresh_token
 *   now-playing                        → Current / last played track
 *   audio-analysis?id=<trackId>        → Audio features + beat timestamps
 *   recent-tracks?limit=<n>            → Listening history (max 50)
 *   top-tracks?range=<short|medium|long>_term&limit=<n>  → Top tracks by term
 *
 * ─── ONE-TIME SETUP ───────────────────────────────────────────────────────
 *   1. Create a Spotify Developer App at https://developer.spotify.com
 *   2. Add redirect URI:  https://<your-vercel-url>/api/spotify?action=callback
 *      (also add http://localhost:5173/api/spotify?action=callback for local dev)
 *   3. Deploy this file to Vercel
 *   4. Visit https://<your-vercel-url>/api/spotify?action=login
 *   5. Authorise — copy the refresh_token from the JSON response
 *   6. Add these env vars in Vercel dashboard:
 *        SPOTIFY_CLIENT_ID
 *        SPOTIFY_CLIENT_SECRET
 *        SPOTIFY_REFRESH_TOKEN
 *   7. Done — refresh token never expires unless you revoke access
 *
 * Required Spotify scopes:
 *   user-read-currently-playing
 *   user-read-recently-played
 *   user-top-read
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

/* ─── env vars ──────────────────────────────────────────────────────────── */

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN!;

const REDIRECT_URI = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}/api/spotify`
  : "http://localhost:5173/api/spotify";

const SCOPES = [
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
].join(" ");

/* ─── shared types ──────────────────────────────────────────────────────── */

interface SpotifyArtist {
  name: string;
}

interface SpotifyImage {
  url: string;
}

interface SpotifyAlbum {
  name:   string;
  images: SpotifyImage[];
}

interface SpotifyTrack {
  id:             string;
  name:           string;
  duration_ms:    number;
  artists:        SpotifyArtist[];
  album:          SpotifyAlbum;
  external_urls:  { spotify: string };
}

interface NormalisedTrack {
  id:       string;
  title:    string;
  artist:   string;
  album:    string;
  albumArt: string | null;
  url:      string;
  duration: number;
}

interface RawBeat {
  start:      number;
  duration:   number;
  confidence: number;
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

function basicAuth(): string {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      Authorization:   basicAuth(),
    },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

function normaliseTrack(track: SpotifyTrack): NormalisedTrack {
  return {
    id:       track.id,
    title:    track.name,
    artist:   track.artists.map((a) => a.name).join(", "),
    album:    track.album.name,
    albumArt: track.album.images[0]?.url ?? null,
    url:      track.external_urls.spotify,
    duration: track.duration_ms,
  };
}

function setCors(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

/* ─── main handler ──────────────────────────────────────────────────────── */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action as string;

  /* ── LOGIN (one-time) ──────────────────────────────────────────────── */
  if (action === "login") {
    const params = new URLSearchParams({
      response_type: "code",
      client_id:     CLIENT_ID,
      scope:         SCOPES,
      redirect_uri:  `${REDIRECT_URI}?action=callback`,
    });
    return res.redirect(`https://accounts.spotify.com/authorize?${params}`);
  }

  /* ── OAUTH CALLBACK ────────────────────────────────────────────────── */
  if (action === "callback") {
    const code = req.query.code as string;
    if (!code) return res.status(400).json({ error: "No code provided" });

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:  basicAuth(),
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: `${REDIRECT_URI}?action=callback`,
      }),
    });

    const data = await tokenRes.json();

    return res.status(200).json({
      message:       "✅ Copy refresh_token into your SPOTIFY_REFRESH_TOKEN env var",
      refresh_token: data.refresh_token,
      access_token:  data.access_token,
    });
  }

  /* ── NOW PLAYING / RECENTLY PLAYED ────────────────────────────────── */
  if (action === "now-playing") {
    try {
      const token = await getAccessToken();

      const currentRes = await fetch(
        "https://api.spotify.com/v1/me/player/currently-playing",
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // 204 = nothing playing; >400 = error
      if (currentRes.status === 204 || currentRes.status > 400) {
        const recentRes = await fetch(
          "https://api.spotify.com/v1/me/player/recently-played?limit=1",
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const recent = await recentRes.json();
        const track: SpotifyTrack | undefined = recent?.items?.[0]?.track;

        if (!track) return res.status(200).json({ isPlaying: false, track: null });

        return res.status(200).json({
          isPlaying: false,
          track:     normaliseTrack(track),
        });
      }

      const current = await currentRes.json();
      const track: SpotifyTrack | undefined = current?.item;

      if (!track) return res.status(200).json({ isPlaying: false, track: null });

      return res.status(200).json({
        isPlaying: current.is_playing,
        progress:  current.progress_ms,
        track:     normaliseTrack(track),
      });

    } catch (err) {
      console.error("[now-playing]", err);
      return res.status(500).json({ error: "Spotify API error" });
    }
  }

  /* ── AUDIO ANALYSIS (features + beat timestamps) ───────────────────── */
  if (action === "audio-analysis") {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing track id" });

    try {
      const token = await getAccessToken();

      const [featuresRes, analysisRes] = await Promise.all([
        fetch(`https://api.spotify.com/v1/audio-features/${id}`,
          { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`https://api.spotify.com/v1/audio-analysis/${id}`,
          { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const features = await featuresRes.json();
      const analysis = await analysisRes.json();

      // Filter low-confidence beats to trim payload size
      const beats: { start: number; duration: number }[] =
        (analysis.beats ?? [])
          .filter((b: RawBeat) => b.confidence > 0.3)
          .map((b: RawBeat) => ({ start: b.start, duration: b.duration }));

      return res.status(200).json({
        tempo:        features.tempo,
        energy:       features.energy,
        valence:      features.valence,
        danceability: features.danceability,
        acousticness: features.acousticness,
        beats,
      });

    } catch (err) {
      console.error("[audio-analysis]", err);
      return res.status(500).json({ error: "Audio analysis error" });
    }
  }

  /* ── RECENT TRACKS ─────────────────────────────────────────────────── */
  if (action === "recent-tracks") {
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 50);

    try {
      const token = await getAccessToken();

      const res_ = await fetch(
        `https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const data = await res_.json();

      // De-duplicate by track id (same song can appear multiple times in history)
      const seen  = new Set<string>();
      const items = (data.items ?? [])
        .filter(({ track }: { track: SpotifyTrack }) => {
          if (seen.has(track.id)) return false;
          seen.add(track.id);
          return true;
        })
        .map(({ track }: { track: SpotifyTrack }) => normaliseTrack(track));

      return res.status(200).json({ items });

    } catch (err) {
      console.error("[recent-tracks]", err);
      return res.status(500).json({ error: "Recent tracks error" });
    }
  }

  /* ── TOP TRACKS ────────────────────────────────────────────────────── */
  if (action === "top-tracks") {
    // time_range: short_term (4 weeks), medium_term (6 months), long_term (years)
    const range = (req.query.range as string) ?? "medium_term";
    const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 50);

    const VALID_RANGES = ["short_term", "medium_term", "long_term"];
    if (!VALID_RANGES.includes(range)) {
      return res.status(400).json({ error: `Invalid range. Use: ${VALID_RANGES.join(", ")}` });
    }

    try {
      const token = await getAccessToken();

      const res_ = await fetch(
        `https://api.spotify.com/v1/me/top/tracks?time_range=${range}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const data = await res_.json();

      const items = (data.items ?? []).map((track: SpotifyTrack) => normaliseTrack(track));

      return res.status(200).json({ items, range, limit });

    } catch (err) {
      console.error("[top-tracks]", err);
      return res.status(500).json({ error: "Top tracks error" });
    }
  }

  /* ── 400 fallthrough ───────────────────────────────────────────────── */
  return res.status(400).json({
    error:           "Unknown action",
    available:       ["login", "callback", "now-playing", "audio-analysis", "recent-tracks", "top-tracks"],
    received:        action ?? "(none)",
  });
}