/**
 * lib/neural-engine.ts
 *
 * In-browser inference for the riff GRU trained in ml/train_gru.py.
 *
 * The model is a single-layer GRU language model over scale-degree tokens.
 * It was trained from scratch in NumPy (manual back-prop-through-time) on a
 * corpus of techno / acid / melodic motifs; the weights live in
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

interface ModelJSON {
  arch: string;
  vocab: (number | null)[]; // null = REST
  E: number;
  H: number;
  V: number;
  weights: {
    Emb: Mat; Wz: Mat; Uz: Mat; bz: Vec; Wr: Mat; Ur: Mat; br: Vec;
    Wh: Mat; Uh: Mat; bh: Vec; V: Mat; bv: Vec;
  };
  trainedOn?: Record<string, number>;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const matVec = (M: Mat, x: Vec): Vec => M.map((row) => { let s = 0; for (let i = 0; i < x.length; i++) s += row[i] * x[i]; return s; });
const add = (a: Vec, b: Vec) => a.map((v, i) => v + b[i]);

export class NeuralRiff {
  private model: ModelJSON | null = null;
  private rootIdx = 0;
  ready = false;
  loading: Promise<void> | null = null;

  /** Fetch + parse the weights once. Safe to call repeatedly. */
  load(url = "/model/riff-gru.json"): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.json(); })
      .then((m: ModelJSON) => {
        this.model = m;
        const i = m.vocab.indexOf(0);
        this.rootIdx = i >= 0 ? i : 0;
        this.ready = true;
      })
      .catch(() => { this.ready = false; }); // never throw — engine falls back to Markov
    return this.loading;
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
   * Generate a riff: `steps` scale-degree tokens (null = rest), starting on
   * the root and sampling autoregressively with temperature.
   */
  sample(steps: number, temperature: number, rng: () => number): (number | null)[] {
    if (!this.ready || !this.model) return [];
    const H = this.model.H;
    const vocab = this.model.vocab;
    const temp = Math.max(0.1, temperature);

    let h = new Array(H).fill(0);
    let tok = this.rootIdx;
    const out: (number | null)[] = [vocab[tok]];

    for (let s = 1; s < steps; s++) {
      const r = this.step(tok, h);
      h = r.h;
      tok = sampleLogits(r.logits, temp, rng);
      out.push(vocab[tok]);
    }
    return out;
  }
}

function sampleLogits(logits: Vec, temp: number, rng: () => number): number {
  let max = -Infinity;
  for (const v of logits) if (v / temp > max) max = v / temp;
  const exps = logits.map((v) => Math.exp(v / temp - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  let x = rng() * sum;
  for (let i = 0; i < exps.length; i++) { x -= exps[i]; if (x <= 0) return i; }
  return exps.length - 1;
}

export const neuralRiff = new NeuralRiff();
