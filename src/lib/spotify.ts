/**
 * lib/spotify.ts
 *
 * Client-side Spotify data layer for Sound×AI.
 * All requests proxy through /api/spotify (Vercel serverless fn).
 *
 * Exports:
 *   fetchNowPlaying()              → NowPlayingData
 *   fetchAudioAnalysis(trackId)    → FullAudioAnalysis
 *   fetchRecentTracks(limit)       → Track[]
 *   buildTasteProfile(tracks)      → RawTasteData  (for taste-profile.ts)
 */

/* ─── types ─────────────────────────────────────────────────────────────── */

export interface Track {
    id:       string;
    title:    string;
    artist:   string;
    album:    string;
    albumArt: string | null;
    url:      string;
    duration: number;
  }
  
  export interface NowPlayingData {
    isPlaying: boolean;
    progress?: number;
    track:     Track | null;
  }
  
  export interface Beat {
    start:    number; // seconds
    duration: number;
  }
  
  export interface AudioFeatures {
    tempo:        number;
    energy:       number;
    valence:      number;
    danceability: number;
    acousticness: number;
  }
  
  export interface FullAudioAnalysis extends AudioFeatures {
    beats: Beat[];
  }
  
  /** Raw multi-track features for building a taste profile */
  export interface RawTrackFeatures {
    id:           string;
    title:        string;
    artist:       string;
    tempo:        number;
    energy:       number;
    valence:      number;
    danceability: number;
    acousticness: number;
  }
  
  /* ─── internal helpers ──────────────────────────────────────────────────── */
  
  const BASE = "/api/spotify";
  
  async function apiFetch<T>(params: Record<string, string>): Promise<T> {
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(`${BASE}?${qs}`);
    if (!res.ok) throw new Error(`Spotify API error ${res.status}`);
    return res.json() as Promise<T>;
  }
  
  /* ─── public API ────────────────────────────────────────────────────────── */
  
  /**
   * Fetch currently playing track, or most recently played if nothing active.
   */
  export async function fetchNowPlaying(): Promise<NowPlayingData> {
    return apiFetch<NowPlayingData>({ action: "now-playing" });
  }
  
  /**
   * Fetch audio features + beat timestamps for a given track ID.
   * Returns full analysis including beat array (filtered to confidence > 0.3).
   */
  export async function fetchAudioAnalysis(trackId: string): Promise<FullAudioAnalysis> {
    return apiFetch<FullAudioAnalysis>({ action: "audio-analysis", id: trackId });
  }
  
  /**
   * Fetch the user's recently played tracks (max 50 via Spotify API).
   * Requires the serverless function to support action=recent-tracks.
   *
   * NOTE: add the `user-read-recently-played` scope if not already present.
   */
  export async function fetchRecentTracks(limit = 50): Promise<Track[]> {
    const data = await apiFetch<{ items: Track[] }>({
      action: "recent-tracks",
      limit:  String(limit),
    });
    return data.items ?? [];
  }
  
  /**
   * Fetch audio features for multiple tracks in parallel (batched, max 5 at a time).
   * Used to enrich recently-played tracks before building the taste profile.
   */
  export async function fetchAudioFeaturesForTracks(
    trackIds: string[]
  ): Promise<Map<string, AudioFeatures>> {
    const map     = new Map<string, AudioFeatures>();
    const BATCH   = 5;
  
    for (let i = 0; i < trackIds.length; i += BATCH) {
      const batch = trackIds.slice(i, i + BATCH);
  
      await Promise.allSettled(
        batch.map(async (id) => {
          try {
            const af = await fetchAudioAnalysis(id);
            map.set(id, {
              tempo:        af.tempo,
              energy:       af.energy,
              valence:      af.valence,
              danceability: af.danceability,
              acousticness: af.acousticness,
            });
          } catch {
            // skip failed tracks silently
          }
        })
      );
    }
  
    return map;
  }
  
  /**
   * Combine Track[] + audio features Map into RawTrackFeatures[].
   * Pass the result into taste-profile.ts → buildTasteProfile().
   */
  export function mergeTracksWithFeatures(
    tracks:   Track[],
    features: Map<string, AudioFeatures>
  ): RawTrackFeatures[] {
    return tracks
      .filter((t) => features.has(t.id))
      .map((t) => {
        const af = features.get(t.id)!;
        return {
          id:           t.id,
          title:        t.title,
          artist:       t.artist,
          tempo:        af.tempo,
          energy:       af.energy,
          valence:      af.valence,
          danceability: af.danceability,
          acousticness: af.acousticness,
        };
      });
  }
  
  /**
   * Convenience: fetch recent tracks AND their audio features in one call.
   * Returns merged RawTrackFeatures[] ready for the taste profiler.
   */
  export async function fetchEnrichedHistory(limit = 50): Promise<RawTrackFeatures[]> {
    const tracks   = await fetchRecentTracks(limit);
    const ids      = tracks.map((t) => t.id);
    const features = await fetchAudioFeaturesForTracks(ids);
    return mergeTracksWithFeatures(tracks, features);
  }