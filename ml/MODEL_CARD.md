# Model card: Sound × AI riff GRU

A small recurrent neural network that writes the melodic riff of a generated
techno track (and, in the ACID style, the 303 line). It runs in the browser with
no ML runtime.

## At a glance

| | |
|---|---|
| **Architecture** | Single-layer GRU language model with a linear softmax head |
| **Embedding / hidden size** | 16 / 96 |
| **Vocabulary** | 24 tokens: `REST`, scale degrees −7 to +14, `BOS` |
| **Parameters** | 35,256 |
| **Framework** | NumPy only: forward pass, back-prop-through-time and Adam are written by hand |
| **Training data** | 9,248 two-bar riffs from 25 electronic and dance artists |
| **Objective** | Next-token cross-entropy, teacher forcing, mini-batches of 64 |
| **Stopping** | Early stopping on validation loss (best epoch 13) |
| **Weights file** | [`public/model/riff-gru.json`](../public/model/riff-gru.json) (about 260 KB, 85 KB gzipped) |

## Results

Lower is better. All scores are next-token negative log-likelihood in nats, on
2,119 riffs by 10 artists the model never saw.

| Model | Test NLL |
|---|---|
| Uniform guess | 3.178 |
| Unigram | 1.765 |
| Bigram | 1.699 |
| Trigram (best baseline) | 1.547 |
| 4-gram | 1.557 |
| **GRU** | **1.243** (95% interval 1.223 to 1.266) |

The GRU beats the best n-gram by 20%. N-gram smoothing was chosen on the validation
set, the same way the GRU was stopped. Scores are in [`results.json`](results.json).

The interval comes from resampling test riffs. With only 10 test artists, it understates
how much the score would move on a different set of artists.

### Why this matters

An earlier version trained on 20 hand-written motifs reached a training loss of about 0.6.
Tested on held-out motifs, it scored 3.3 to 4.6 nats, worse than random guessing: it had
memorised its data. That result is why the model was retrained on real MIDI with a proper
split, early stopping and a baseline.

## Data

[`prepare_dataset.py`](prepare_dataset.py) reads the
[Lakh MIDI "clean" subset](https://colinraffel.com/projects/lmd/) (Raffel, 2016) and keeps a
list of electronic and dance artists. Its dependency-free MIDI parser read 593 files and
produced 13,502 unique riffs from 52 artists ([stats](data_stats.json)).

1. Keep 4/4 files. Estimate the key with Krumhansl-Kessler profiles.
2. Keep synth, lead and bass tracks, and quantise onsets to 16ths. Parts with more than 15% of
   notes off the grid are dropped, which removes triplet and free-time playing.
3. Slice two-bar windows at a one-bar hop and convert pitches to scale degrees.
4. Fold each phrase into the register the app plays in, then remove exact duplicates.

**The split is by artist**: train 9,248 riffs, validation 2,135, test 2,119.
Splitting by riff or by file would put near-copies of the same song on both sides. The
MIDI files are not redistributed here. Only the trained weights and statistics are.

## Representation

A riff is 32 tokens on a 16th-note grid. Each token is a **scale degree** relative to the
track's root (`0` = root, `7` = octave) or `REST`. Working in scale degrees rather than
raw MIDI keeps the vocabulary small and lets one model play in any key and scale.

## Correctness checks

- **Gradients:** `python3 ml/train_gru.py --check` compares the hand-written backprop with
  numerical differentiation. Worst relative error: 2.2e-07.
- **Browser parity:** [`neural-engine.test.ts`](../src/lib/neural-engine.test.ts) scores held-out
  riffs with the TypeScript forward pass and must match the Python result
  ([`parity_fixture.json`](parity_fixture.json)).

## Inference

The forward pass is re-implemented in [`neural-engine.ts`](../src/lib/neural-engine.ts) with
the gate equations from training:

```
z = σ(Wz·x + Uz·h + bz)
r = σ(Wr·x + Ur·h + br)
n = tanh(Wh·x + r ⊙ (Uh·h) + bh)
h' = (1 − z) ⊙ n + z ⊙ h
logits = V·h' + bv
```

Generation is autoregressive with temperature sampling from `BOS`. The "Inside the riff
model" panel shows the distribution at each step. Clicking a cell holds that note, and the
network continues from it, so the rest of the riff changes. If the weights fail to load, the
engine falls back to a Markov chain so generation never breaks.

## Reproduce it

```bash
python3 ml/prepare_dataset.py <path-to-clean_midi>
python3 ml/train_gru.py
python3 ml/export_fixture.py
```

Training takes about 90 seconds on a laptop CPU.

## Limitations

- **It is not a techno corpus.** Lakh has little real techno, so this data is electronic and
  dance music more broadly, including pop-leaning acts. No open techno riff dataset with a
  usable licence turned up.
- **Rests dominate.** About 62% of tokens are rests, so much of the score comes from
  predicting rhythm.
- **It models one line.** Bass (outside ACID), drums and harmony remain rule-based.
- **A better score doesn't guarantee a better riff.** NLL measures prediction of real data,
  not whether a person prefers the output.
