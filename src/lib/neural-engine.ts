/**
 * lib/neural-engine.ts
 *
 * In-browser inference for the riff GRU trained in ml/train_gru.py.
 *
 * The model is a single-layer GRU language model over scale-degree tokens,
 * trained from scratch in NumPy on riffs from real MIDI. The weights live in
 * public/model/riff-gru.json. Here we re-implement *only the forward pass*
 * (the same gate equations as training) plus temperature sampling — so the
 * network runs client-side with zero ML runtime dependency.
 *
 *   z = σ(Wz·x + Uz·h + bz)
 *   r = σ(Wr·x + Ur·h + br)
 *   n = tanh(Wh·x + r ⊙ (Uh·h) + bh)
 *   h' = (1 − z) ⊙ n + z ⊙ h
 *   logits = V·h' + bv
 */

type Mat = number[][];
type Vec = number[];

export interface ModelJSON {
  arch: string;
  vocab: (number | null)[]; // null = REST or BOS
  bos: number;
  E: number;
  H: number;
  V: number;
  weights: {
    Emb: Mat; Wz: Mat; Uz: Mat; bz: Vec; Wr: Mat; Ur: Mat; br: Vec;
    Wh: Mat; Uh: Mat; bh: Vec; V: Mat; bv: Vec;
  };
  trainedOn?: { riffs: number; dataset: string; testNats: number; baselineNats: number };
}

export interface RiffSample {
  tokens: number[];
  degrees: (number | null)[];
  probs: number[][]; // the distribution each step was drawn from
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const matVec = (M: Mat, x: Vec): Vec => M.map((row) => { let s = 0; for (let i = 0; i < x.length; i++) s += row[i] * x[i]; return s; });
const add = (a: Vec, b: Vec) => a.map((v, i) => v + b[i]);

export class NeuralRiff {
  private model: ModelJSON | null = null;
  ready = false;
  loading: Promise<void> | null = null;

  /** Fetch + parse the weights once. Safe to call repeatedly. */
  load(url = "/model/riff-gru.json"): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.json(); })
      .then((m: ModelJSON) => { this.use(m); })
      .catch(() => { this.ready = false; }); // never throw — engine falls back to Markov
    return this.loading;
  }

  /** Install parsed weights directly. */
  use(m: ModelJSON): void {
    this.model = m;
    this.ready = true;
  }

  get vocab(): (number | null)[] {
    return this.model?.vocab ?? [];
  }

  get meta(): ModelJSON["trainedOn"] {
    return this.model?.trainedOn;
  }

  /** One GRU step: returns next hidden state + output logits over the vocab. */
  private step(token: number, h: Vec): { h: Vec; logits: Vec } {
    const w = this.model!.weights;
    const x = w.Emb[token];
    const z = add(add(matVec(w.Wz, x), matVec(w.Uz, h)), w.bz).map(sigmoid);
    const r = add(add(matVec(w.Wr, x), matVec(w.Ur, h)), w.br).map(sigmoid);
    const uh = matVec(w.Uh, h);
    const n = add(matVec(w.Wh, x), w.bh).map((v, i) => Math.tanh(v + r[i] * uh[i]));
    const hNew = h.map((hi, i) => (1 - z[i]) * n[i] + z[i] * hi);
    const logits = add(matVec(w.V, hNew), w.bv);
    return { h: hNew, logits };
  }

  /**
   * Generate a riff of `steps` tokens, sampling autoregressively with
   * temperature from the start token. A pinned step uses the given token, and
   * the model carries on from there, so a held note changes what comes after it.
   */
  sample(steps: number, temperature: number, rng: () => number, pins: Record<number, number> = {}): RiffSample {
    const empty: RiffSample = { tokens: [], degrees: [], probs: [] };
    if (!this.ready || !this.model) return empty;
    const { H, vocab, bos } = this.model;
    const temp = Math.max(0.1, temperature);
    const out = empty;

    let h = new Array(H).fill(0);
    let tok = bos;
    for (let s = 0; s < steps; s++) {
      const r = this.step(tok, h);
      h = r.h;
      const probs = softmax(r.logits, temp, bos);
      const drawn = draw(probs, rng); // always drawn, so a pin leaves later steps comparable
      tok = pins[s] ?? drawn;
      out.tokens.push(tok);
      out.degrees.push(vocab[tok]);
      out.probs.push(probs);
    }
    return out;
  }

  /** Mean next-token negative log-likelihood of `seqs`, in nats. */
  score(seqs: number[][]): number {
    const { H, bos } = this.model!;
    let total = 0, n = 0;
    for (const seq of seqs) {
      let h = new Array(H).fill(0);
      let tok = bos;
      for (const next of seq) {
        const r = this.step(tok, h);
        h = r.h;
        total -= Math.log(softmax(r.logits, 1, -1)[next]);
        n++;
        tok = next;
      }
    }
    return total / n;
  }
}

/** Softmax with temperature. `skip` removes a token the model must never emit. */
function softmax(logits: Vec, temp: number, skip: number): Vec {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (i !== skip && logits[i] / temp > max) max = logits[i] / temp;
  const exps = logits.map((v, i) => (i === skip ? 0 : Math.exp(v / temp - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

function draw(probs: Vec, rng: () => number): number {
  let x = rng();
  for (let i = 0; i < probs.length; i++) { x -= probs[i]; if (x <= 0) return i; }
  return probs.length - 1;
}

export const neuralRiff = new NeuralRiff();
