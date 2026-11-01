/**
 * lib/audio/samples.ts
 *
 * Loads and caches the recorded sample pack. Each style only fetches the kit it
 * needs. If a file fails to load, a small stand-in is built so the track still
 * plays: a missing sample should never stop the demo.
 */

const BASE = "/samples/";

export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<void>>();
  private flipped = new Map<string, AudioBuffer>();
  readonly failed = new Set<string>();

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  get(id: string): AudioBuffer {
    const buf = this.buffers.get(id);
    if (!buf) throw new Error(`sample not loaded: ${id}`);
    return buf;
  }

  /** The same sample played backwards, for risers and swells. */
  reversed(ctx: BaseAudioContext, id: string): AudioBuffer {
    const hit = this.flipped.get(id);
    if (hit) return hit;
    const src = this.get(id);
    const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const data = src.getChannelData(c).slice().reverse();
      out.copyToChannel(data, c);
    }
    this.flipped.set(id, out);
    return out;
  }

  /** Fetch + decode everything in `ids`, reporting 0–1 progress. */
  async ensure(ctx: BaseAudioContext, ids: string[], onProgress: (p: number) => void = () => {}): Promise<void> {
    const unique = [...new Set(ids)];
    let done = 0;
    await Promise.all(unique.map(async (id) => {
      await this.loadOne(ctx, id);
      onProgress(++done / unique.length);
    }));
  }

  private loadOne(ctx: BaseAudioContext, id: string): Promise<void> {
    if (this.buffers.has(id)) return Promise.resolve();
    const running = this.pending.get(id);
    if (running) return running;
    const job = fetch(`${BASE}${id}.flac`)
      .then((r) => { if (!r.ok) throw new Error(`${id}: ${r.status}`); return r.arrayBuffer(); })
      .then((data) => ctx.decodeAudioData(data))
      .then((buf) => { this.buffers.set(id, buf); })
      .catch(() => {
        this.failed.add(id);
        this.buffers.set(id, standIn(ctx, id));
      })
      .finally(() => { this.pending.delete(id); });
    this.pending.set(id, job);
    return job;
  }
}

/** A plain decaying tone or noise burst, shaped by what the sample was meant to be. */
function standIn(ctx: BaseAudioContext, id: string): AudioBuffer {
  const low = /^(kick|bass|drone|boom|tom)/.test(id);
  const noisy = /^(hat|clap|ride|crash|shaker|rim|cymbal|vinyl|gong|fx)/.test(id);
  const seconds = id.startsWith("ir_") ? 0.5 : low ? 0.5 : 0.25;
  const buf = ctx.createBuffer(1, Math.floor(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  const hz = low ? 55 : 220;
  for (let i = 0; i < data.length; i++) {
    const t = i / ctx.sampleRate;
    const env = Math.exp(-t * (low ? 7 : 22));
    data[i] = env * (noisy ? Math.random() * 2 - 1 : Math.sin(2 * Math.PI * hz * t));
  }
  return buf;
}

export const sampleBank = new SampleBank();
