"""내려받은 획 데이터를 qd-raster-v1 규칙으로 28x28 이미지로 만들고 세트를 나눈다.

    python prepare.py

결과: data/prepared/{train,val,test,val_partial}.npz, data/prepared/manifest.json
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from multiprocessing import Pool

import numpy as np

from config import (
    CLASSES,
    MAX_TRAIN_PER_CLASS,
    MIN_EVAL_PER_CLASS,
    MIN_TRAIN_PER_CLASS,
    PARTIAL_TRAIN_FRACTION,
    PREPARED_DIR,
    RAW_DIR,
    SPLIT_MODULO,
)
from rasterize import SPEC, quickdraw_strokes, rasterize

SEED = 20261113


def split_of(key_id: str) -> str:
    h = int(hashlib.sha1(key_id.encode()).hexdigest(), 16) % SPLIT_MODULO
    return "test" if h == 0 else "val" if h == 1 else "train"


def to_u8(img: np.ndarray) -> np.ndarray:
    return np.round(img * 255).astype(np.uint8)


def process_class(args):
    index, class_id = args
    rng = random.Random(SEED + index)
    seen = set()
    buckets = {"train": [], "val": [], "test": []}
    skipped = {"unrecognized": 0, "duplicate": 0, "empty": 0}

    with open(RAW_DIR / f"{class_id}.ndjson", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            key = row["key_id"]
            if not row.get("recognized", False):
                skipped["unrecognized"] += 1
                continue
            if key in seen:
                skipped["duplicate"] += 1
                continue
            seen.add(key)
            strokes = quickdraw_strokes(row["drawing"])
            if not strokes:
                skipped["empty"] += 1
                continue
            buckets[split_of(key)].append((key, strokes))

    # 세트 안 순서는 key 해시 순으로 고정한다(파일 순서와 무관하게 재현).
    for name in buckets:
        buckets[name].sort(key=lambda item: hashlib.sha1(item[0].encode()).hexdigest())
    buckets["train"] = buckets["train"][:MAX_TRAIN_PER_CLASS]

    out = {}
    for name, items in buckets.items():
        out[name] = (np.stack([to_u8(rasterize(s)) for _, s in items]), [k for k, _ in items])

    # 그리는 중간 단계: 학습 세트 일부에 앞부분 획만 남긴 샘플을 더한다.
    partial = []
    for key, strokes in buckets["train"]:
        if len(strokes) >= 2 and rng.random() < PARTIAL_TRAIN_FRACTION:
            k = rng.randint(math.ceil(len(strokes) / 2), len(strokes) - 1)
            partial.append(to_u8(rasterize(strokes[:k])))
    out["train_partial"] = (np.stack(partial) if partial else np.zeros((0, 28, 28), np.uint8), [])

    # 검증용 중간 단계: 획이 2개 이상인 검증 그림의 앞쪽 절반 획.
    vp = [to_u8(rasterize(s[: math.ceil(len(s) / 2)])) for _, s in buckets["val"] if len(s) >= 2]
    out["val_partial"] = (np.stack(vp), [])

    return index, class_id, out, skipped


def main() -> None:
    PREPARED_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [(i, c[0]) for i, c in enumerate(CLASSES)]
    with Pool() as pool:
        results = sorted(pool.map(process_class, jobs))

    manifest = {"seed": SEED, "raster": SPEC, "splitRule": f"sha1(key_id) % {SPLIT_MODULO}: 0=test, 1=val, else train",
                "recognizedOnly": True, "classes": {}, "files": {}}
    sets = {"train": ([], []), "val": ([], []), "test": ([], []), "val_partial": ([], [])}
    keys = {"train": {}, "val": {}, "test": {}}

    for index, class_id, out, skipped in results:
        counts = {}
        for name, (x, k) in out.items():
            counts[name] = int(len(x))
            target = "train" if name == "train_partial" else name
            sets[target][0].append(x)
            sets[target][1].append(np.full(len(x), index, dtype=np.int16))
            if name in keys:
                keys[name][class_id] = k
        if counts["train"] < MIN_TRAIN_PER_CLASS or counts["val"] < MIN_EVAL_PER_CLASS or counts["test"] < MIN_EVAL_PER_CLASS:
            raise SystemExit(f"{class_id}: 데이터 부족 {counts}. config.DOWNLOAD_BYTES_PER_CLASS 를 늘리세요.")
        manifest["classes"][class_id] = {"counts": counts, "skipped": skipped}
        print(f"{class_id:16s} {counts}")

    for name, (xs, ys) in sets.items():
        path = PREPARED_DIR / f"{name}.npz"
        np.savez_compressed(path, x=np.concatenate(xs), y=np.concatenate(ys))
        manifest["files"][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()

    (PREPARED_DIR / "split_keys.json").write_text(json.dumps(keys), "utf-8")
    raw_manifest = json.loads((RAW_DIR / "manifest.json").read_text("utf-8"))
    manifest["rawFiles"] = {k: v["sha256"] for k, v in raw_manifest["files"].items()}
    (PREPARED_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print("done")


if __name__ == "__main__":
    main()
