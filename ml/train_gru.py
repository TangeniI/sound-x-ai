"""
train_gru.py - Sound x AI riff model

Trains a single-layer GRU language model from scratch in NumPy: hand-written
forward pass, back-prop-through-time and Adam, no ML framework. It predicts the
next 16th-note token of a two-bar riff from real MIDI (see prepare_dataset.py).

Training stops on the validation loss. The final score is measured on artists
the model never saw, next to n-gram baselines, and written to ml/results.json.

The weights are exported to public/model/riff-gru.json, and the forward pass is
re-implemented in TypeScript (src/lib/neural-engine.ts), so the model runs in the
browser with zero ML runtime dependency.

Run:  python3 ml/train_gru.py            (after prepare_dataset.py)
      python3 ml/train_gru.py --check    (numerical gradient check only)
"""

import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
E, H = 16, 96
BATCH = 64
LR, LR_DECAY = 0.003, 0.97
WEIGHT_DECAY = 1e-5
CLIP = 5.0
MAX_EPOCHS = 80
PATIENCE = 8


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


# ─────────────────────────────────────────────────────────────────────────────
# GRU (single layer), implemented from scratch. All operations are batched:
# hidden states are (B, H) and each row is one riff.
#
#   z = σ(Wz·x + Uz·h + bz)
#   r = σ(Wr·x + Ur·h + br)
#   n = tanh(Wh·x + r ⊙ (Uh·h) + bh)
#   h' = (1 − z) ⊙ n + z ⊙ h
#   logits = V·h' + bv
# ─────────────────────────────────────────────────────────────────────────────
class GRU:
    def __init__(self, vocab_size, rng, e=E, h=H):
        self.V, self.E, self.H = vocab_size, e, h
        s = 0.08
        r = rng
        self.p = {
            "Emb": r.standard_normal((vocab_size, e)) * s,
            "Wz": r.standard_normal((h, e)) * s, "Uz": r.standard_normal((h, h)) * s, "bz": np.zeros(h),
            "Wr": r.standard_normal((h, e)) * s, "Ur": r.standard_normal((h, h)) * s, "br": np.zeros(h),
            "Wh": r.standard_normal((h, e)) * s, "Uh": r.standard_normal((h, h)) * s, "bh": np.zeros(h),
            "V": r.standard_normal((vocab_size, h)) * s, "bv": np.zeros(vocab_size),
        }
        self.m = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.v = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.t = 0

    def forward(self, inputs):
        """Run a (B, T) token batch and keep what the backward pass needs."""
        p = self.p
        B, T = inputs.shape
        h = np.zeros((B, self.H))
        cache = []
        for t in range(T):
            x = p["Emb"][inputs[:, t]]
            z = sigmoid(x @ p["Wz"].T + h @ p["Uz"].T + p["bz"])
            r = sigmoid(x @ p["Wr"].T + h @ p["Ur"].T + p["br"])
            uh = h @ p["Uh"].T
            n = np.tanh(x @ p["Wh"].T + r * uh + p["bh"])
            hnew = (1 - z) * n + z * h
            logits = hnew @ p["V"].T + p["bv"]
            cache.append((x, h, z, r, uh, n, hnew, logits))
            h = hnew
        return cache

    @staticmethod
    def log_probs(logits):
        shifted = logits - logits.max(axis=1, keepdims=True)
        return shifted - np.log(np.exp(shifted).sum(axis=1, keepdims=True))

    def loss(self, inputs, targets):
        """Mean next-token negative log-likelihood, in nats."""
        total = 0.0
        for t, c in enumerate(self.forward(inputs)):
            lp = self.log_probs(c[-1])
            total -= lp[np.arange(len(lp)), targets[:, t]].sum()
        return total / targets.size

    def loss_and_grads(self, inputs, targets):
        p = self.p
        cache = self.forward(inputs)
        B, T = inputs.shape
        g = {k: np.zeros_like(v) for k, v in p.items()}
        total = 0.0
        dh_next = np.zeros((B, self.H))
        for t in reversed(range(T)):
            x, hprev, z, r, uh, n, hnew, logits = cache[t]
            lp = self.log_probs(logits)
            rows = np.arange(B)
            total -= lp[rows, targets[:, t]].sum()

            dlogits = np.exp(lp)
            dlogits[rows, targets[:, t]] -= 1
            g["V"] += dlogits.T @ hnew
            g["bv"] += dlogits.sum(0)
            dh = dlogits @ p["V"] + dh_next

            dn = dh * (1 - z)
            dz = dh * (hprev - n)
            dhprev = dh * z

            dn_raw = dn * (1 - n * n)
            g["Wh"] += dn_raw.T @ x
            g["Uh"] += (dn_raw * r).T @ hprev
            g["bh"] += dn_raw.sum(0)
            dhprev = dhprev + (dn_raw * r) @ p["Uh"]

            dr_raw = (dn_raw * uh) * r * (1 - r)
            g["Wr"] += dr_raw.T @ x
            g["Ur"] += dr_raw.T @ hprev
            g["br"] += dr_raw.sum(0)
            dhprev = dhprev + dr_raw @ p["Ur"]

            dz_raw = dz * z * (1 - z)
            g["Wz"] += dz_raw.T @ x
            g["Uz"] += dz_raw.T @ hprev
            g["bz"] += dz_raw.sum(0)
            dhprev = dhprev + dz_raw @ p["Uz"]

            dx = dz_raw @ p["Wz"] + dr_raw @ p["Wr"] + dn_raw @ p["Wh"]
            np.add.at(g["Emb"], inputs[:, t], dx)
            dh_next = dhprev

        scale = 1.0 / targets.size
        for k in g:
            g[k] *= scale
        return total * scale, g

    def step(self, g, lr):
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        norm = math.sqrt(sum(float((v ** 2).sum()) for v in g.values()))
        clip = min(1.0, CLIP / (norm + 1e-9))
        for k in self.p:
            grad = g[k] * clip + WEIGHT_DECAY * self.p[k]
            self.m[k] = b1 * self.m[k] + (1 - b1) * grad
            self.v[k] = b2 * self.v[k] + (1 - b2) * grad * grad
            mhat = self.m[k] / (1 - b1 ** self.t)
            vhat = self.v[k] / (1 - b2 ** self.t)
            self.p[k] -= lr * mhat / (np.sqrt(vhat) + eps)

    def snapshot(self):
        return {k: v.copy() for k, v in self.p.items()}


# ─────────────────────────────────────────────────────────────────────────────
# Baselines. Smoothing is picked on validation, the same way the GRU is stopped.
# ─────────────────────────────────────────────────────────────────────────────
class NGram:
    def __init__(self, order, vocab_size, alpha):
        self.order, self.V, self.alpha = order, vocab_size, alpha
        self.counts, self.totals = {}, {}

    def fit(self, sequences):
        for seq in sequences:
            for i in range(len(seq) - 1):
                ctx = tuple(seq[max(0, i - self.order + 2):i + 1]) if self.order > 1 else ()
                row = self.counts.setdefault(ctx, {})
                row[seq[i + 1]] = row.get(seq[i + 1], 0) + 1
                self.totals[ctx] = self.totals.get(ctx, 0) + 1
        return self

    def nll(self, sequences):
        total, n = 0.0, 0
        for seq in sequences:
            for i in range(len(seq) - 1):
                ctx = tuple(seq[max(0, i - self.order + 2):i + 1]) if self.order > 1 else ()
                count = self.counts.get(ctx, {}).get(seq[i + 1], 0)
                prob = (count + self.alpha) / (self.totals.get(ctx, 0) + self.alpha * self.V)
                total -= math.log(prob)
                n += 1
        return total / n


def best_ngram(order, V, train, val, test):
    best = None
    for alpha in (0.01, 0.03, 0.1, 0.3, 1.0):
        model = NGram(order, V, alpha).fit(train)
        score = model.nll(val)
        if best is None or score < best[0]:
            best = (score, alpha, model)
    return {"order": order, "alpha": best[1], "val": best[0], "test": best[2].nll(test)}


def with_bos(riffs, bos):
    return np.concatenate([np.full((len(riffs), 1), bos, dtype=np.int64), riffs.astype(np.int64)], axis=1)


def bootstrap(fn, rng, rounds=200):
    """95% interval from resampling the test riffs."""
    scores = [fn(rng) for _ in range(rounds)]
    return [float(np.percentile(scores, 2.5)), float(np.percentile(scores, 97.5))]


# ─────────────────────────────────────────────────────────────────────────────
def gradient_check():
    rng = np.random.default_rng(1)
    model = GRU(7, rng, e=4, h=5)
    seq = rng.integers(0, 7, size=(3, 7))
    inputs, targets = seq[:, :-1], seq[:, 1:]
    _, grads = model.loss_and_grads(inputs, targets)
    worst = 0.0
    for key, param in model.p.items():
        flat = param.reshape(-1)
        for i in rng.choice(flat.size, size=min(8, flat.size), replace=False):
            keep = flat[i]
            eps = 1e-5
            flat[i] = keep + eps
            up = model.loss(inputs, targets)
            flat[i] = keep - eps
            down = model.loss(inputs, targets)
            flat[i] = keep
            numeric = (up - down) / (2 * eps)
            analytic = grads[key].reshape(-1)[i]
            worst = max(worst, abs(numeric - analytic) / max(1e-4, abs(numeric) + abs(analytic)))
    print(f"gradient check: worst relative error {worst:.2e}")
    assert worst < 1e-4
    return worst


def main():
    grad_error = gradient_check()
    if "--check" in sys.argv:
        return
    data = np.load(os.path.join(HERE, "data", "riffs.npz"), allow_pickle=True)
    vocab = [str(v) for v in data["vocab"]]
    bos = vocab.index("BOS")
    train, val, test = (with_bos(data[k], bos) for k in ("train", "val", "test"))
    V = len(vocab)
    print(f"riffs train={len(train)} val={len(val)} test={len(test)} vocab={V}", flush=True)

    rng = np.random.default_rng(7)
    model = GRU(V, rng)
    best_val, best_params, best_epoch, bad, lr = float("inf"), model.snapshot(), 0, 0, LR
    history = []
    started = time.time()
    for epoch in range(MAX_EPOCHS):
        order = rng.permutation(len(train))
        total, batches = 0.0, 0
        for i in range(0, len(order), BATCH):
            batch = train[order[i:i + BATCH]]
            loss, grads = model.loss_and_grads(batch[:, :-1], batch[:, 1:])
            model.step(grads, lr)
            total += loss
            batches += 1
        val_loss = model.loss(val[:, :-1], val[:, 1:])
        history.append({"epoch": epoch + 1, "train": total / batches, "val": val_loss})
        print(f"epoch {epoch + 1:3d}  train {total / batches:.4f}  val {val_loss:.4f}  "
              f"lr {lr:.5f}  {time.time() - started:.0f}s", flush=True)
        if val_loss < best_val - 1e-4:
            best_val, best_params, best_epoch, bad = val_loss, model.snapshot(), epoch + 1, 0
        else:
            bad += 1
            if bad >= PATIENCE:
                break
        lr *= LR_DECAY

    model.p = best_params
    tr_list, va_list, te_list = train.tolist(), val.tolist(), test.tolist()
    baselines = [best_ngram(n, V, tr_list, va_list, te_list) for n in (1, 2, 3, 4)]
    gru_test = model.loss(test[:, :-1], test[:, 1:])

    boot = np.random.default_rng(11)

    def gru_sample(r):
        idx = r.integers(0, len(test), size=len(test))
        return model.loss(test[idx, :-1], test[idx, 1:])

    results = {
        "metric": "next-token negative log-likelihood (nats), lower is better",
        "uniform": math.log(V),
        "ngrams": baselines,
        "gru": {
            "E": E, "H": H, "bestEpoch": best_epoch, "val": best_val, "test": gru_test,
            "test95": bootstrap(gru_sample, boot, 40),
            "parameters": int(sum(v.size for v in model.p.values())),
        },
        "gradientCheckWorstRelativeError": grad_error,
        "history": history,
    }
    with open(os.path.join(HERE, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    print(json.dumps({"gru_test": gru_test, "ngrams": [(b["order"], round(b["test"], 4)) for b in baselines],
                      "uniform": math.log(V)}), flush=True)

    out = {
        "arch": "gru-1layer",
        "vocab": [None if t in ("REST", "BOS") else int(t) for t in vocab],
        "bos": bos,
        "E": E, "H": H, "V": V,
        "weights": {k: np.round(v, 4).tolist() for k, v in model.p.items()},
        "trainedOn": {
            "riffs": len(train),
            "dataset": "Lakh MIDI clean, electronic artists",
            "testNats": round(gru_test, 4),
            "baselineNats": round(min(b["test"] for b in baselines), 4),
        },
    }
    path = os.path.join(HERE, "..", "public", "model", "riff-gru.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"saved {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
