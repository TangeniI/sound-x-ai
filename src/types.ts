/**
 * src/types.ts
 * Shared types used across components and lib files.
 * Import from here instead of defining locally in each file.
 */

export interface AudioFeatures {
    tempo:        number;
    energy:       number;
    valence:      number;
    danceability: number;
    acousticness: number;
    beats?:       { start: number; duration: number }[];
  }
  
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
  
  export interface NoteEvent {
    pitch:      number;
    startTime:  number;
    endTime:    number;
    velocity:   number;
    instrument: "melody" | "chords" | "drums";
  }