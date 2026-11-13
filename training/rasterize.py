"""그림 전처리 규칙 qd-raster-v1.

app/src/preprocess.ts 와 같은 알고리즘이다. 한쪽을 고치면 다른 쪽도 고치고
`python make_fixture.py` 로 교차 검증 데이터를 다시 만든 뒤 앱 테스트를 돌린다.

1. 점이 없는 획을 버린다.
2. 전체 경계 상자의 긴 변을 255로 맞추고 왼쪽 위에 붙인다(Quick Draw 단순화 규칙).
3. 각 획을 Ramer-Douglas-Peucker(epsilon 2.0)로 단순화한다.
4. 255 공간을 28x28 안쪽 24x24(여백 2)에 종횡비를 유지해 가운데 배치한다.
5. 각 픽셀 중심에서 가장 가까운 선분까지 거리 d를 구해
   값 = clip(HALF_WIDTH + 0.5 - d, 0, 1). 1이 잉크, 0이 바탕이다.
"""

from __future__ import annotations

import numpy as np

SPEC = {
    "name": "qd-raster-v1",
    "size": 28,
    "pad": 2.0,
    "halfWidth": 0.9,
    "normalizeTo": 255.0,
    "rdpEpsilon": 2.0,
}

SIZE = SPEC["size"]
PAD = SPEC["pad"]
HALF_WIDTH = SPEC["halfWidth"]
NORMALIZE_TO = SPEC["normalizeTo"]
RDP_EPSILON = SPEC["rdpEpsilon"]

_ys, _xs = np.mgrid[0:SIZE, 0:SIZE]
_CENTERS = np.stack([_xs.ravel() + 0.5, _ys.ravel() + 0.5], axis=1).astype(np.float64)


def _point_segment_distance(p, a, b):
    abx, aby = b[0] - a[0], b[1] - a[1]
    l2 = abx * abx + aby * aby
    if l2 == 0:
        return float(np.hypot(p[0] - a[0], p[1] - a[1]))
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2
    t = min(1.0, max(0.0, t))
    return float(np.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby))


def rdp(points: np.ndarray, epsilon: float = RDP_EPSILON) -> np.ndarray:
    """반복형 RDP. 첫 점과 끝 점은 항상 남긴다. 최대 거리가 같으면 앞쪽 점을 고른다."""
    n = len(points)
    if n <= 2:
        return points
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start, end = stack.pop()
        best, index = -1.0, -1
        for i in range(start + 1, end):
            d = _point_segment_distance(points[i], points[start], points[end])
            if d > best:
                best, index = d, i
        if index >= 0 and best > epsilon:
            keep[index] = True
            stack.append((start, index))
            stack.append((index, end))
    return points[keep]


def to_segments(strokes) -> np.ndarray:
    """획 목록(각 획은 [[x, y], ...])을 28 공간 선분 (S, 4)로 바꾼다.

    Quick Draw [[xs], [ys]] 형식은 quickdraw_strokes()로 먼저 바꾼다.
    """
    lines = []
    for stroke in strokes:
        if len(stroke) == 0:
            continue
        arr = np.asarray(stroke, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[1] != 2:
            continue
        if not np.all(np.isfinite(arr)):
            continue
        lines.append(arr)
    if not lines:
        return np.zeros((0, 4))

    allp = np.concatenate(lines)
    mn = allp.min(axis=0)
    mx = allp.max(axis=0)
    extent = float(max(mx[0] - mn[0], mx[1] - mn[1]))

    if extent <= 0:
        c = SIZE / 2.0
        return np.array([[c, c, c, c]])

    s = NORMALIZE_TO / extent
    w, h = (mx[0] - mn[0]) * s, (mx[1] - mn[1]) * s
    k = (SIZE - 2 * PAD) / NORMALIZE_TO
    ox = (SIZE - w * k) / 2.0
    oy = (SIZE - h * k) / 2.0

    segs = []
    for line in lines:
        norm = (line - mn) * s
        simple = rdp(norm)
        q = np.empty_like(simple)
        q[:, 0] = simple[:, 0] * k + ox
        q[:, 1] = simple[:, 1] * k + oy
        if len(q) == 1:
            segs.append([q[0, 0], q[0, 1], q[0, 0], q[0, 1]])
        else:
            for i in range(len(q) - 1):
                segs.append([q[i, 0], q[i, 1], q[i + 1, 0], q[i + 1, 1]])
    return np.asarray(segs, dtype=np.float64)


def raster_segments(segs: np.ndarray) -> np.ndarray:
    if len(segs) == 0:
        return np.zeros((SIZE, SIZE), dtype=np.float32)
    a = segs[:, 0:2]
    ab = segs[:, 2:4] - a
    l2 = (ab * ab).sum(axis=1)
    safe = np.where(l2 > 0, l2, 1.0)
    ap = _CENTERS[:, None, :] - a[None, :, :]
    t = (ap * ab[None]).sum(axis=-1) / safe[None]
    t = np.clip(t, 0.0, 1.0)
    t = np.where(l2[None] > 0, t, 0.0)
    diff = ap - t[..., None] * ab[None]
    d = np.sqrt((diff * diff).sum(axis=-1)).min(axis=1)
    v = np.clip(HALF_WIDTH + 0.5 - d, 0.0, 1.0)
    return v.reshape(SIZE, SIZE).astype(np.float32)


def rasterize(strokes) -> np.ndarray:
    return raster_segments(to_segments(strokes))


def quickdraw_strokes(drawing):
    """Quick Draw [[xs], [ys]] 획을 [[x, y], ...] 획으로 바꾼다."""
    return [list(zip(s[0], s[1])) for s in drawing]
