"""
export_fixture.py - proves the browser model matches the trained one.

Scores a few held-out riffs in Python with the exported weights and saves them
with the result. src/lib/neural-engine.test.ts must reach the same number.

Run:  python3 ml/export_fixture.py   (after train_gru.py)
"""

import json
import os

import numpy as np

from train_gru import GRU, HERE, with_bos

model_json = json.load(open(os.path.join(HERE, "..", "public", "model", "riff-gru.json")))
data = np.load(os.path.join(HERE, "data", "riffs.npz"), allow_pickle=True)
riffs = data["test"][:: max(1, len(data["test"]) // 24)][:24]

model = GRU(model_json["V"], np.random.default_rng(0), e=model_json["E"], h=model_json["H"])
model.p = {k: np.array(v, dtype=float) for k, v in model_json["weights"].items()}
batch = with_bos(riffs, model_json["bos"])
score = model.loss(batch[:, :-1], batch[:, 1:])

with open(os.path.join(HERE, "parity_fixture.json"), "w") as f:
    json.dump({"riffs": riffs.tolist(), "nats": score}, f)
print(f"fixture: {len(riffs)} riffs, {score:.6f} nats")
