import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasEnoughInput, RASTER_SPEC, rasterize, type Stroke } from '../src/preprocess';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/raster.json', import.meta.url), 'utf8')) as {
  spec: typeof RASTER_SPEC;
  cases: { name: string; strokes: Stroke[]; pixels: number[] }[];
};

describe('전처리 qd-raster-v1 (Python 학습 코드와 교차 검증)', () => {
  it('규칙 상수가 학습 코드와 같다', () => {
    expect(fixture.spec).toEqual(RASTER_SPEC);
  });

  for (const c of fixture.cases) {
    it(`${c.name}: 28x28 결과가 Python 과 일치`, () => {
      const out = rasterize(c.strokes);
      expect(out.length).toBe(784);
      let maxDiff = 0;
      out.forEach((v, i) => (maxDiff = Math.max(maxDiff, Math.abs(v - c.pixels[i]))));
      expect(maxDiff).toBeLessThan(1e-5);
    });
  }

  it('같은 그림은 위치와 크기가 달라도 같은 입력이 된다', () => {
    const a: Stroke[] = [[[0, 0], [50, 30], [100, 0]]];
    const b: Stroke[] = [[[300, 500], [400, 560], [500, 500]]];
    const ra = rasterize(a);
    const rb = rasterize(b);
    ra.forEach((v, i) => expect(Math.abs(v - rb[i])).toBeLessThan(1e-9));
  });

  it('빈 그림과 극히 짧은 접촉은 입력이 부족하다', () => {
    expect(hasEnoughInput([])).toBe(false);
    expect(hasEnoughInput([[[10, 10]]])).toBe(false);
    expect(hasEnoughInput([[[10, 10], [14, 12]]])).toBe(false);
    expect(hasEnoughInput([[[10, 10], [60, 10]]])).toBe(true);
  });
});
