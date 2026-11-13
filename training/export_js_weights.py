"""체험판(단일 HTML)용 가중치를 내보낸다. BatchNorm 을 합성곱에 합쳐 순수 JS 로 계산할 수 있게 한다.

    python export_js_weights.py --version qd20-v1   ->  app/src/demo/weights.json
"""

import argparse
import base64
import json

import numpy as np
import torch

from config import ROOT, RUNS_DIR

OUT = ROOT.parent / "app" / "src" / "demo" / "weights.json"


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--version", required=True)
    args = p.parse_args()
    state = torch.load(RUNS_DIR / args.version / "model.pt", map_location="cpu")

    convs = []
    # features: block(0) block(1) pool(2) block(3) block(4) pool(5) block(6) gap(7)
    for idx in [0, 1, 3, 4, 6]:
        w = state[f"features.{idx}.0.weight"].numpy()
        g = state[f"features.{idx}.1.weight"].numpy()
        beta = state[f"features.{idx}.1.bias"].numpy()
        mean = state[f"features.{idx}.1.running_mean"].numpy()
        var = state[f"features.{idx}.1.running_var"].numpy()
        scale = g / np.sqrt(var + 1e-5)
        wf = w * scale[:, None, None, None]
        bf = beta - mean * scale
        convs.append({"out": int(w.shape[0]), "in": int(w.shape[1]), "w": b64(wf), "b": b64(bf), "poolAfter": idx in (1, 4)})
    fc = {"out": int(state["fc.weight"].shape[0]), "in": int(state["fc.weight"].shape[1]),
          "w": b64(state["fc.weight"].numpy()), "b": b64(state["fc.bias"].numpy())}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": args.version, "convs": convs, "fc": fc}), "utf-8")
    print(f"-> {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
