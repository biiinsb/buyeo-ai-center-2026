"""20종 그림 분류 CNN을 학습하고 ONNX 모델 묶음을 앱에 내보낸다.

    python train.py --version qd20-v1 [--epochs 12]

검증 세트로 가장 좋은 가중치를 고르고, 시험 세트는 마지막에 한 번만 평가한다.
결과: runs/<version>/ (보고서, 혼동 행렬), app/public/model/ (model.onnx, bundle.json)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import shutil
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from config import APP_MODEL_DIR, CLASSES, PREPARED_DIR, RUNS_DIR, SOURCE_LICENSE, SUCCESS_RULE
from rasterize import SPEC

SEED = 20261113


class DoodleNet(nn.Module):
    """28x28 흑백 입력, 20종 점수 출력. 파라미터 약 14만 개."""

    def __init__(self, num_classes: int = 20):
        super().__init__()

        def block(cin, cout):
            return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))

        self.features = nn.Sequential(
            block(1, 32), block(32, 32), nn.MaxPool2d(2),   # 14
            block(32, 64), block(64, 64), nn.MaxPool2d(2),  # 7
            block(64, 128),
            nn.AdaptiveAvgPool2d(1),
        )
        self.dropout = nn.Dropout(0.3)
        self.fc = nn.Linear(128, num_classes)

    def forward(self, x):
        return self.fc(self.dropout(torch.flatten(self.features(x), 1)))


class WithSoftmax(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return torch.softmax(self.net(x), dim=1)


def load(name):
    d = np.load(PREPARED_DIR / f"{name}.npz")
    x = torch.from_numpy(d["x"]).unsqueeze(1)  # uint8 (N,1,28,28)
    y = torch.from_numpy(d["y"].astype(np.int64))
    return x, y


def augment(x: torch.Tensor, gen: torch.Generator) -> torch.Tensor:
    """위치, 크기, 약한 회전. 실제 입력은 경계 상자에 맞춰 가운데 배치되므로 범위를 작게 둔다."""
    n = x.shape[0]
    angle = (torch.rand(n, generator=gen) * 2 - 1) * math.radians(12)
    scale = 0.85 + torch.rand(n, generator=gen) * 0.25
    tx = (torch.rand(n, generator=gen) * 2 - 1) * 0.10
    ty = (torch.rand(n, generator=gen) * 2 - 1) * 0.10
    apply = torch.rand(n, generator=gen) < 0.8
    angle[~apply] = 0
    scale[~apply] = 1
    tx[~apply] = 0
    ty[~apply] = 0
    cos, sin = torch.cos(angle) / scale, torch.sin(angle) / scale
    theta = torch.stack([torch.stack([cos, -sin, tx], 1), torch.stack([sin, cos, ty], 1)], 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    return F.grid_sample(x, grid, align_corners=False, padding_mode="zeros")


@torch.no_grad()
def predict(model, x, batch=2048):
    model.eval()
    out = []
    for i in range(0, len(x), batch):
        out.append(torch.softmax(model(x[i : i + batch].float() / 255), 1))
    return torch.cat(out)


def metrics(probs: torch.Tensor, y: torch.Tensor, n: int) -> dict:
    top = probs.argmax(1)
    conf = torch.zeros(n, n, dtype=torch.int64)
    for t, p in zip(y.tolist(), top.tolist()):
        conf[t, p] += 1
    recall = (conf.diag().float() / conf.sum(1).clamp(min=1)).tolist()
    s = probs.sort(1, descending=True).values
    fire = (s[:, 0] >= SUCCESS_RULE["minScore"]) & ((s[:, 0] - s[:, 1]) >= SUCCESS_RULE["minMargin"])
    correct = top == y
    return {
        "count": int(len(y)),
        "top1": float(correct.float().mean()),
        "top3": float((probs.topk(3, 1).indices == y[:, None]).any(1).float().mean()),
        "recall": recall,
        "minRecall": float(min(recall)),
        "successRule": {
            "fireRate": float(fire.float().mean()),
            "fireAndCorrect": float((fire & correct).float().mean()),
            "precisionWhenFired": float((fire & correct).sum() / fire.sum().clamp(min=1)),
        },
        "confusion": conf.tolist(),
    }


LOG = None


def log(msg: str) -> None:
    """콘솔과 runs/<version>/train.log 에 바로 쓴다(파이프에 막히지 않게 flush)."""
    stamp = dt.datetime.now().strftime("%H:%M:%S")
    line = f"[{stamp}] {msg}"
    print(line, flush=True)
    if LOG is not None:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-3)
    args = parser.parse_args()

    torch.manual_seed(SEED)
    torch.set_num_threads(os.cpu_count() or 4)
    gen = torch.Generator().manual_seed(SEED)
    n = len(CLASSES)
    ids = [c[0] for c in CLASSES]

    xtr, ytr = load("train")
    xva, yva = load("val")
    xvp, yvp = load("val_partial")
    print(f"train {len(xtr):,}  val {len(xva):,}  val_partial {len(xvp):,}", flush=True)

    model = DoodleNet(n)
    params = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * math.ceil(len(xtr) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.15)

    run_dir = RUNS_DIR / args.version
    run_dir.mkdir(parents=True, exist_ok=True)
    global LOG
    LOG = run_dir / "train.log"
    log(f"start {args.version}: params {params:,}, epochs {args.epochs}, batch {args.batch}")
    best, best_state, history = -1.0, None, []
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        order = torch.randperm(len(xtr), generator=gen)
        total = 0.0
        for i in range(0, len(order), args.batch):
            idx = order[i : i + args.batch]
            xb = augment(xtr[idx].float() / 255, gen)
            loss = F.cross_entropy(model(xb), ytr[idx])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item() * len(idx)
            step = i // args.batch + 1
            if step % 200 == 0:
                done = min(i + args.batch, len(order))
                log(f"epoch {epoch}/{args.epochs} {done * 100 // len(order)}% loss {total / done:.4f} ({time.time() - t0:.0f}s)")
        val = metrics(predict(model, xva), yva, n)
        history.append({"epoch": epoch, "loss": total / len(xtr), "valTop1": val["top1"], "valMinRecall": val["minRecall"], "sec": round(time.time() - t0, 1)})
        log(f"epoch {epoch}/{args.epochs} done: loss {total / len(xtr):.4f} val top1 {val['top1']:.4f} min recall {val['minRecall']:.4f} ({time.time() - t0:.0f}s)")
        if val["top1"] > best:
            best = val["top1"]
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    torch.save(best_state, run_dir / "model.pt")

    log("evaluating test set and exporting ONNX")
    xte, yte = load("test")
    report = {
        "version": args.version,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "parameters": params,
        "torch": torch.__version__,
        "args": vars(args),
        "seed": SEED,
        "history": history,
        "val": metrics(predict(model, xva), yva, n),
        "valPartial": metrics(predict(model, xvp), yvp, n),
        "test": metrics(predict(model, xte), yte, n),
        "classes": ids,
        "dataManifest": json.loads((PREPARED_DIR / "manifest.json").read_text("utf-8")),
    }

    # ONNX 내보내기(소프트맥스 포함, 입력 [N,1,28,28] 0~1).
    model.eval()
    onnx_path = run_dir / "model.onnx"
    torch.onnx.export(
        WithSoftmax(model), torch.zeros(1, 1, 28, 28), onnx_path,
        input_names=["input"], output_names=["probs"],
        dynamic_axes={"input": {0: "n"}, "probs": {0: "n"}}, opset_version=17, dynamo=False,
    )

    import onnxruntime as ort  # noqa: E402

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    sample = (xte[:256].float() / 255).numpy()
    diff = np.abs(sess.run(None, {"input": sample})[0] - predict(model, xte[:256]).numpy()).max()
    report["onnxMaxAbsDiff"] = float(diff)
    if diff > 1e-4:
        raise SystemExit(f"ONNX 출력 불일치 {diff}")

    (run_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    with open(run_dir / "confusion_test.csv", "w", encoding="utf-8") as f:
        f.write("true\\pred," + ",".join(ids) + "\n")
        for cid, row in zip(ids, report["test"]["confusion"]):
            f.write(cid + "," + ",".join(map(str, row)) + "\n")

    # 앱 모델 묶음
    APP_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx_path, APP_MODEL_DIR / "model.onnx")
    bundle = {
        "bundleFormat": 1,
        "version": args.version,
        "createdAt": report["createdAt"],
        "model": {"file": "model.onnx", "sha256": sha256(APP_MODEL_DIR / "model.onnx"),
                  "bytes": (APP_MODEL_DIR / "model.onnx").stat().st_size,
                  "input": {"name": "input", "shape": [1, 1, 28, 28], "range": [0, 1]},
                  "output": {"name": "probs", "classes": n, "activation": "softmax"}},
        "preprocess": SPEC,
        "labels": [{"index": i, "id": c[0], "word": c[1], "source": c[2], "level": c[3]} for i, c in enumerate(CLASSES)],
        "successRule": SUCCESS_RULE,
        "metrics": {"testTop1": report["test"]["top1"], "testMinRecall": report["test"]["minRecall"],
                    "valPartialTop1": report["valPartial"]["top1"]},
        "dataLicense": SOURCE_LICENSE,
    }
    (APP_MODEL_DIR / "bundle.json").write_text(json.dumps(bundle, ensure_ascii=False, indent=2), "utf-8")

    t = report["test"]
    print(f"\nparams {params:,}  onnx {bundle['model']['bytes']:,} bytes")
    print(f"TEST top1 {t['top1']:.4f}  top3 {t['top3']:.4f}  min recall {t['minRecall']:.4f}")
    print(f"partial(val) top1 {report['valPartial']['top1']:.4f}")
    print(f"success rule on test: {t['successRule']}")
    for cid, r in sorted(zip(ids, t["recall"]), key=lambda z: z[1]):
        print(f"  {cid:16s} {r:.3f}")


if __name__ == "__main__":
    main()
