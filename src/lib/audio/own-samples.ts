/**
 * lib/audio/own-samples.ts
 *
 * The producer's own sounds. A dropped file is checked, measured and kept in this
 * browser's IndexedDB. Nothing is uploaded: the id is a hash of the file, so the same
 * file added twice is kept once, and a share link never carries it.
 */

import { ownKickRoots } from "./kits";

export interface OwnSample { id: string; name: string; seconds: number; root?: number }
interface Stored extends OwnSample { bytes: ArrayBuffer }

const DB = "soundxai-own-samples";
const STORE = "samples";
/** One-shots, not songs: long files would fill the browser's storage. */
export const MAX_SECONDS = 12;
const MAX_BYTES = 20 * 1024 * 1024;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = work(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * The pitch of a kick's body: the strongest frequency from 25 to 160 Hz, 40 to
 * 250 ms in, past the click. The same measurement gave the stock kicks' roots.
 */
export function measureKickRoot(data: Float32Array, sampleRate: number): number | undefined {
  const from = Math.floor(0.04 * sampleRate);
  const to = Math.min(data.length, Math.floor(0.25 * sampleRate));
  if (to - from < 0.05 * sampleRate) return undefined;
  let best = 0;
  let bestHz = 0;
  // a direct scan at 0.25 Hz steps is plenty for 25–160 Hz, and needs no FFT
  for (let hz = 25; hz <= 160; hz += 0.25) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * hz) / sampleRate;
    for (let i = from; i < to; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
      re += data[i] * win * Math.cos(w * i);
      im += data[i] * win * Math.sin(w * i);
    }
    const power = re * re + im * im;
    if (power > best) [best, bestHz] = [power, hz];
  }
  if (!best) return undefined;
  return Math.round((69 + 12 * Math.log2(bestHz / 440)) * 10) / 10;
}

async function hash(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Check, measure and keep a file. Throws a message fit to show when it can't be used. */
export async function addOwnSample(file: File, measureAsKick: boolean): Promise<OwnSample> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 20 MB. Use a one-shot or a short loop.`);
  const bytes = await file.arrayBuffer();
  let audio: AudioBuffer;
  try {
    audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(`${file.name} isn't audio this browser can read. Try WAV, AIFF, MP3 or FLAC.`);
  }
  if (audio.duration > MAX_SECONDS) throw new Error(`${file.name} is ${Math.round(audio.duration)} s long. Sounds can be up to ${MAX_SECONDS} s.`);
  const id = `user:${await hash(bytes)}`;
  const root = measureAsKick ? measureKickRoot(audio.getChannelData(0), audio.sampleRate) : undefined;
  const sample: Stored = { id, name: file.name.replace(/\.[^.]+$/, ""), seconds: audio.duration, root, bytes };
  await run("readwrite", (s) => s.put(sample));
  if (root != null) ownKickRoots.set(id, root);
  return { id, name: sample.name, seconds: sample.seconds, root };
}

/** What's kept, without the audio. Also restores the kicks' measured roots. */
export async function listOwnSamples(): Promise<OwnSample[]> {
  if (typeof indexedDB === "undefined") return [];
  try {
    const all = await run<Stored[]>("readonly", (s) => s.getAll());
    for (const x of all) if (x.root != null) ownKickRoots.set(x.id, x.root);
    return all.map(({ id, name, seconds, root }) => ({ id, name, seconds, root }));
  } catch {
    return []; // private windows can refuse storage; the stock sounds still work
  }
}

export async function ownSampleBytes(id: string): Promise<ArrayBuffer> {
  const found = await run<Stored | undefined>("readonly", (s) => s.get(id));
  if (!found) throw new Error(`${id} isn't on this device`);
  return found.bytes.slice(0);
}

export async function removeOwnSample(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
  ownKickRoots.delete(id);
}
