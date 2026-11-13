/** 체험판 순수 JS 추론이 ONNX(Python) 결과와 같은 점수를 내는지 확인한다. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JsNet, type WeightsJson } from '../src/demo/jsnet';
import { rasterize, type Stroke } from '../src/preprocess';

const weights = JSON.parse(readFileSync(new URL('../src/demo/weights.json', import.meta.url), 'utf8')) as WeightsJson;
const bundle = JSON.parse(readFileSync(new URL('../public/model/bundle.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/raster.json', import.meta.url), 'utf8')) as {
  cases: { name: string; strokes: Stroke[]; probs?: number[] }[];
};

describe('체험판 순수 JS 추론', () => {
  it('키오스크 모델 묶음과 같은 버전이다', () => {
    expect(weights.version).toBe(bundle.version);
  });

  it('ONNX 와 같은 20종 점수를 낸다', () => {
    const net = new JsNet(weights);
    for (const c of fixture.cases) {
      const probs = net.run(rasterize(c.strokes));
      expect(probs.length).toBe(20);
      probs.forEach((v, i) => expect(Math.abs(v - c.probs![i]), `${c.name}[${i}]`).toBeLessThan(1e-4));
    }
  });
});
