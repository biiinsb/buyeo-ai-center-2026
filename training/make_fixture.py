"""Python 전처리 결과를 앱 테스트용 교차 검증 데이터로 저장한다.

    python make_fixture.py   ->  app/tests/fixtures/raster.json
"""

import json
import random

from config import CLASSES, RAW_DIR, ROOT
from rasterize import SPEC, quickdraw_strokes, rasterize

OUT = ROOT.parent / "app" / "tests" / "fixtures" / "raster.json"


def main():
    rng = random.Random(7)
    cases = []
    # 실제 Quick Draw 그림 몇 장
    for class_id, *_ in CLASSES[:: 4]:
        with open(RAW_DIR / f"{class_id}.ndjson", encoding="utf-8") as f:
            row = json.loads(next(f))
        strokes = quickdraw_strokes(row["drawing"])
        cases.append({"name": f"quickdraw-{class_id}", "strokes": strokes})
    # 터치 화면 좌표를 흉내 낸 입력: 소수 좌표, 큰 스케일, 세로로 긴 그림, 점 하나
    wobble = [[(200 + 300 * (i / 80) + rng.uniform(-2, 2), 600 + 40 * ((i % 10) - 5) + rng.uniform(-2, 2)) for i in range(81)]]
    cases.append({"name": "touch-wobble", "strokes": wobble})
    cases.append({"name": "tall", "strokes": [[(500.25, 100.5), (510.75, 900.125)], [(480, 120), (530, 120)]]})
    cases.append({"name": "dot", "strokes": [[(320.0, 410.0)]]})
    cases.append({"name": "two-dots", "strokes": [[(10.0, 10.0)], [(90.0, 50.0)]]})
    cases.append({"name": "empty", "strokes": []})
    model = ROOT.parent / "app" / "public" / "model" / "model.onnx"
    sess = None
    if model.exists():
        import onnxruntime as ort

        sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    for c in cases:
        c["strokes"] = [[[float(x), float(y)] for x, y in s] for s in c["strokes"]]
        img = rasterize(c["strokes"])
        c["pixels"] = [round(float(v), 7) for v in img.ravel()]
        if sess is not None:
            probs = sess.run(None, {"input": img.reshape(1, 1, 28, 28)})[0][0]
            c["probs"] = [float(v) for v in probs]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"spec": SPEC, "cases": cases}), "utf-8")
    print(f"{len(cases)} cases -> {OUT} (model probs: {sess is not None})")


if __name__ == "__main__":
    main()
