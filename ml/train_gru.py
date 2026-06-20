"""
train_gru.py — Sound x AI riff model

Trains a single-layer GRU language model (from scratch, NumPy only — manual
forward + backprop-through-time + Adam) to predict the next note of a techno
riff. The riff is represented as a sequence of *scale-degree* tokens on a 16th
grid (0 = root, 7 = octave, negatives go below the root; a dedicated REST token
marks silence).

The trained weights are exported to ../public/model/riff-gru.json and the
forward pass is re-implemented in TypeScript (src/lib/neural-engine.ts) so the
model runs in the browser with zero ML runtime dependency.

Run:  python3 ml/train_gru.py
"""

import json
import math
import os
import numpy as np

np.random.seed(7)
REST = "REST"

# ─────────────────────────────────────────────────────────────────────────────
# Corpus — hand-authored techno / acid / hypnotic motifs (one bar = 16 steps).
# Numbers are scale degrees (0 = root, 7 = octave up, -7 = octave down); None =
# rest. These encode the *idioms* the GRU learns transitions and phrasing from.
# ─────────────────────────────────────────────────────────────────────────────
R = None
CORPUS = [
    # acid: root-heavy, octave jumps, b3 / b7 colour
    [0, R, 0, 7, 0, R, 2, 0, 0, R, 7, 0, 6, R, 0, R],
    [0, 0, 7, 0, 2, 0, 7, 0, 0, 0, 7, 6, 4, 2, 0, R],
    [0, R, 7, R, 0, R, 3, R, 0, R, 7, R, 5, R, 2, R],
    [0, 7, 0, 7, 2, 7, 0, 7, 0, 7, 0, 7, 6, 7, 4, 7],
    [0, R, 0, 2, 3, 2, 0, R, 7, R, 6, 4, 3, 2, 0, R],
    # hypnotic: sparse, repetitive, small range
    [0, R, R, R, 3, R, R, R, 0, R, R, R, 2, R, R, R],
    [0, R, R, 2, R, R, 0, R, 0, R, R, 2, R, R, 3, R],
    [0, R, 2, R, 3, R, 2, R, 0, R, 2, R, 3, R, 4, R],
    [4, R, R, R, 3, R, R, R, 2, R, R, R, 0, R, R, R],
    [0, R, R, R, R, R, 3, R, 0, R, R, R, R, R, 2, R],
    # melodic techno: flowing lines, wider contour
    [0, 2, 4, 2, 0, -3, 0, 2, 4, 5, 4, 2, 0, 2, 4, 7],
    [7, 5, 4, 2, 0, 2, 4, 5, 7, 9, 7, 5, 4, 2, 0, R],
    [0, 4, 7, 4, 5, 4, 2, 0, 0, 4, 7, 9, 7, 5, 4, 2],
    [2, 4, 5, 7, 5, 4, 2, 0, -3, 0, 2, 4, 5, 4, 2, 0],
    [0, 2, 0, 4, 0, 5, 4, 2, 0, 2, 0, 4, 7, 5, 4, 2],
    # driving riffs: punchy, syncopated
    [0, 0, R, 3, 0, R, 0, 2, 0, 0, R, 3, 0, R, 4, 2],
    [0, R, 3, 3, 0, R, 2, 2, 0, R, 3, 3, 0, R, 5, 4],
    [0, 0, 7, R, 0, 0, 5, R, 0, 0, 7, R, 0, 0, 4, R],
    [7, R, 0, R, 5, R, 0, R, 4, R, 0, R, 2, R, 0, R],
    [0, 3, 2, 0, 0, 3, 2, 0, 0, 3, 5, 4, 2, 0, -3, R],
]


def transpose(seq, shift):
    return [None if x is None else x + shift for x in seq]


def build_dataset():
    """Augment the corpus with transpositions and assemble the vocab."""
    data = []
    for seq in CORPUS:
        for shift in (-2, -1, 0, 1, 2):
            t = transpose(seq, shift)
            if all(x is None or -7 <= x <= 12 for x in t):
                data.append(t)
    # vocab: REST + every degree that appears
    degrees = sorted({x for seq in data for x in seq if x is not None})
    vocab = [REST] + degrees
    tok2idx = {tok: i for i, tok in enumerate(vocab)}

    def encode(seq):
        return [tok2idx[REST if x is None else x] for x in seq]

    encoded = [encode(seq) for seq in data]
    return encoded, vocab, tok2idx


# ─────────────────────────────────────────────────────────────────────────────
# GRU (single layer), implemented from scratch.
# ─────────────────────────────────────────────────────────────────────────────
def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


class GRU:
    def __init__(self, vocab, E=12, H=32):
        self.vocab = vocab
        V = len(vocab)
        self.E, self.H, self.V = E, H, V
        s = 0.1
        self.p = {
            "Emb": np.random.randn(V, E) * s,
            "Wz": np.random.randn(H, E) * s, "Uz": np.random.randn(H, H) * s, "bz": np.zeros(H),
            "Wr": np.random.randn(H, E) * s, "Ur": np.random.randn(H, H) * s, "br": np.zeros(H),
            "Wh": np.random.randn(H, E) * s, "Uh": np.random.randn(H, H) * s, "bh": np.zeros(H),
            "V":  np.random.randn(V, H) * s, "bv": np.zeros(V),
        }
        self.m = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.v = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.t = 0

    def loss_and_grads(self, seq):
        """Teacher-forced next-token cross-entropy over one sequence + BPTT."""
        p = self.p
        H = self.H
        xs, hs, zs, rs, ns, uhs, ps = {}, {}, {}, {}, {}, {}, {}
        hs[-1] = np.zeros(H)
        loss = 0.0
        T = len(seq) - 1
        for t in range(T):
            x = p["Emb"][seq[t]]
            xs[t] = x
            hprev = hs[t - 1]
            z = sigmoid(p["Wz"] @ x + p["Uz"] @ hprev + p["bz"])
            r = sigmoid(p["Wr"] @ x + p["Ur"] @ hprev + p["br"])
            uh = p["Uh"] @ hprev
            n = np.tanh(p["Wh"] @ x + r * uh + p["bh"])
            h = (1 - z) * n + z * hprev
            zs[t], rs[t], ns[t], uhs[t], hs[t] = z, r, n, uh, h
            logits = p["V"] @ h + p["bv"]
            logits -= logits.max()
            e = np.exp(logits)
            prob = e / e.sum()
            ps[t] = prob
            loss -= math.log(prob[seq[t + 1]] + 1e-9)

        g = {k: np.zeros_like(v) for k, v in p.items()}
        dh_next = np.zeros(H)
        for t in reversed(range(T)):
            dlogits = ps[t].copy()
            dlogits[seq[t + 1]] -= 1
            g["V"] += np.outer(dlogits, hs[t])
            g["bv"] += dlogits
            dh = p["V"].T @ dlogits + dh_next

            z, r, n, uh, hprev = zs[t], rs[t], ns[t], uhs[t], hs[t - 1]
            x = xs[t]
            dn = dh * (1 - z)
            dz = dh * (hprev - n)
            dhprev = dh * z

            dn_raw = dn * (1 - n * n)
            g["Wh"] += np.outer(dn_raw, x)
            g["Uh"] += np.outer(dn_raw * r, hprev)
            g["bh"] += dn_raw
            dr = dn_raw * uh
            dhprev += (p["Uh"].T @ (dn_raw * r))

            dz_raw = dz * z * (1 - z)
            g["Wz"] += np.outer(dz_raw, x)
            g["Uz"] += np.outer(dz_raw, hprev)
            g["bz"] += dz_raw
            dhprev += p["Uz"].T @ dz_raw

            dr_raw = dr * r * (1 - r)
            g["Wr"] += np.outer(dr_raw, x)
            g["Ur"] += np.outer(dr_raw, hprev)
            g["br"] += dr_raw
            dhprev += p["Ur"].T @ dr_raw

            dx = p["Wz"].T @ dz_raw + p["Wr"].T @ dr_raw + p["Wh"].T @ dn_raw
            g["Emb"][seq[t]] += dx
            dh_next = dhprev

        return loss / max(1, T), g

    def step(self, g, lr=0.01, clip=5.0):
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        for k in self.p:
            grad = np.clip(g[k], -clip, clip)
            self.m[k] = b1 * self.m[k] + (1 - b1) * grad
            self.v[k] = b2 * self.v[k] + (1 - b2) * grad * grad
            mhat = self.m[k] / (1 - b1 ** self.t)
            vhat = self.v[k] / (1 - b2 ** self.t)
            self.p[k] -= lr * mhat / (np.sqrt(vhat) + eps)


def main():
    data, vocab, _ = build_dataset()
    print(f"sequences={len(data)} vocab={len(vocab)} degrees={vocab[1:]}")
    model = GRU(vocab, E=12, H=32)

    EPOCHS = 400
    for ep in range(EPOCHS):
        np.random.shuffle(data)
        total = 0.0
        for seq in data:
            loss, g = model.loss_and_grads(seq)
            model.step(g, lr=0.01)
            total += loss
        if ep % 40 == 0 or ep == EPOCHS - 1:
            print(f"epoch {ep:4d}  loss {total / len(data):.4f}")

    out = {
        "arch": "gru-1layer",
        "vocab": [None if t == REST else t for t in vocab],
        "E": model.E, "H": model.H, "V": model.V,
        "weights": {k: np.round(v, 5).tolist() for k, v in model.p.items()},
        "trainedOn": {"motifs": len(CORPUS), "augmentedSequences": len(data), "epochs": EPOCHS},
    }
    path = os.path.join(os.path.dirname(__file__), "..", "public", "model", "riff-gru.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size = os.path.getsize(path) / 1024
    print(f"saved {path}  ({size:.0f} KB)")


if __name__ == "__main__":
    main()
