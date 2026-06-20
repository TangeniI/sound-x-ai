# Model card — Sound × AI riff GRU

A small recurrent neural network that generates the melodic **riff** line of a
generated techno track. It replaces the first-order Markov chain used elsewhere
with a model that learns longer-range phrasing (contour, rests, repetition).

## At a glance

| | |
|---|---|
| **Architecture** | Single-layer GRU language model + linear softmax head |
| **Embedding dim** | 12 |
| **Hidden units** | 32 |
| **Vocabulary** | 18 tokens — `REST` + scale degrees −5…+11 |
| **Parameters** | ~6k |
| **Framework** | **NumPy only** — forward pass, back-prop-through-time and Adam written from scratch (no PyTorch/TF) |
| **Training data** | 20 hand-authored techno / acid / hypnotic / melodic motifs, ×5 transpositions = 100 sequences |
| **Objective** | Next-token cross-entropy (teacher forcing) |
| **Training** | 400 epochs, Adam (lr 0.01), grad-clip 5 |
| **Result** | train loss 2.37 → ~0.6 |
| **Artifact** | [`public/model/riff-gru.json`](../public/model/riff-gru.json) (~43 KB) |

## Representation

A riff is a sequence of tokens on a 16th-note grid. Each token is a **scale
degree** relative to the track's root (`0` = root, `7` = octave, negatives go
below), or `REST`. Working in scale-degree space (not raw MIDI) keeps the
vocabulary tiny and lets the same model play in any key/mode the engine chooses.

## Inference

The forward pass is re-implemented in TypeScript
([`src/lib/neural-engine.ts`](../src/lib/neural-engine.ts)) using the exact gate
equations from training:

```
z = σ(Wz·x + Uz·h + bz)
r = σ(Wr·x + Ur·h + br)
n = tanh(Wh·x + r ⊙ (Uh·h) + bh)
h' = (1 − z) ⊙ n + z ⊙ h
logits = V·h' + bv
```

Generation is autoregressive with temperature sampling, primed on the root.
Running inference by hand (rather than via ONNX/TF.js) keeps the app dependency
-free and makes the maths explicit. If the model fails to load, the engine
falls back to the Markov motif model, so generation never breaks.

## Train it yourself

```bash
python3 ml/train_gru.py     # numpy only; writes public/model/riff-gru.json
```

## Limitations

- Trained on a small, hand-authored corpus — it learns *idioms*, not the full
  diversity of real techno. Swapping in a larger MIDI dataset (e.g. Groove MIDI)
  is the obvious next step.
- Models the lead line only; bass, drums and harmony remain rule-based.
