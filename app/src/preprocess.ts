/**
 * 그림 전처리 규칙 qd-raster-v1.
 * training/rasterize.py 와 같은 알고리즘이다. 한쪽을 고치면 다른 쪽도 고치고
 * tests/preprocess.test.ts 의 교차 검증을 통과시킨다.
 */
export type Point = readonly [number, number];
export type Stroke = readonly Point[];

export interface RasterSpec {
  name: string;
  size: number;
  pad: number;
  halfWidth: number;
  normalizeTo: number;
  rdpEpsilon: number;
}

export const RASTER_SPEC: RasterSpec = {
  name: 'qd-raster-v1',
  size: 28,
  pad: 2,
  halfWidth: 0.9,
  normalizeTo: 255,
  rdpEpsilon: 2,
};

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby);
}

/** 반복형 RDP. 첫 점과 끝 점은 항상 남긴다. 최대 거리가 같으면 앞쪽 점을 고른다. */
export function rdp<T extends Point>(points: readonly T[], epsilon: number): T[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let best = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistance(points[i], points[start], points[end]);
      if (d > best) {
        best = d;
        index = i;
      }
    }
    if (index >= 0 && best > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** 획 목록을 28 공간 선분 [x1, y1, x2, y2] 배열로 바꾼다. */
export function toSegments(strokes: readonly Stroke[], spec: RasterSpec = RASTER_SPEC): number[][] {
  const lines = strokes.filter(
    (s) => s.length > 0 && s.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
  );
  if (!lines.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines)
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  const extent = Math.max(maxX - minX, maxY - minY);
  const { size, pad, normalizeTo } = spec;
  if (extent <= 0) {
    const c = size / 2;
    return [[c, c, c, c]];
  }

  const s = normalizeTo / extent;
  const w = (maxX - minX) * s;
  const h = (maxY - minY) * s;
  const k = (size - 2 * pad) / normalizeTo;
  const ox = (size - w * k) / 2;
  const oy = (size - h * k) / 2;

  const segs: number[][] = [];
  for (const line of lines) {
    const norm: Point[] = line.map(([x, y]) => [(x - minX) * s, (y - minY) * s]);
    const q = rdp(norm, spec.rdpEpsilon).map(([x, y]) => [x * k + ox, y * k + oy] as const);
    if (q.length === 1) segs.push([q[0][0], q[0][1], q[0][0], q[0][1]]);
    else for (let i = 0; i < q.length - 1; i++) segs.push([q[i][0], q[i][1], q[i + 1][0], q[i + 1][1]]);
  }
  return segs;
}

/** 선분을 size x size 흑백 이미지(행 우선, 1=잉크)로 그린다. */
export function rasterSegments(segs: readonly number[][], spec: RasterSpec = RASTER_SPEC): Float32Array {
  const { size, halfWidth } = spec;
  const out = new Float32Array(size * size);
  if (!segs.length) return out;
  const reach = halfWidth + 0.5;
  for (let py = 0; py < size; py++) {
    const cy = py + 0.5;
    for (let px = 0; px < size; px++) {
      const cx = px + 0.5;
      let best = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        const abx = bx - ax;
        const aby = by - ay;
        const apx = cx - ax;
        const apy = cy - ay;
        const l2 = abx * abx + aby * aby;
        let t = l2 > 0 ? (apx * abx + apy * aby) / l2 : 0;
        t = Math.min(1, Math.max(0, t));
        const dx = apx - t * abx;
        const dy = apy - t * aby;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      out[py * size + px] = Math.min(1, Math.max(0, reach - best));
    }
  }
  return out;
}

export function rasterize(strokes: readonly Stroke[], spec: RasterSpec = RASTER_SPEC): Float32Array {
  return rasterSegments(toSegments(strokes, spec), spec);
}

/** 화면 좌표 기준으로 충분한 입력인지 확인한다. 빈 그림과 극히 짧은 접촉은 판정에서 뺀다. */
export function hasEnoughInput(strokes: readonly Stroke[], minLengthPx = 24): boolean {
  let length = 0;
  for (const s of strokes) for (let i = 1; i < s.length; i++) length += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
  return length >= minLengthPx;
}
