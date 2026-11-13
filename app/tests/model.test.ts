/**
 * 실제 모델 묶음을 onnxruntime-web(WASM, 단일 스레드)으로 실행해
 * Python(onnxruntime) 결과와 같은 20종 점수가 나오는지 확인한다.
 * 네트워크 없이 로컬 파일만 읽는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web/wasm';
import { rasterize, type Stroke } from '../src/preprocess';
import { rank } from '../src/judge';

const modelPath = new URL('../public/model/model.onnx', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/raster.json', import.meta.url), 'utf8')) as {
  cases: { name: string; strokes: Stroke[]; probs?: number[] }[];
};
const ready = existsSync(modelPath) && fixture.cases.every((c) => c.probs);

describe.runIf(ready)('실제 모델 (onnxruntime-web WASM)', () => {
  it('Python 과 같은 점수를 내고, 같은 그림은 언제나 같은 점수다', async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = new URL('../public/ort/', import.meta.url).href;
    const session = await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ['wasm'] });
    const times: number[] = [];
    for (const c of fixture.cases) {
      const t0 = performance.now();
      const out = await session.run({ input: new ort.Tensor('float32', rasterize(c.strokes), [1, 1, 28, 28]) });
      times.push(performance.now() - t0);
      const probs = out.probs.data as Float32Array;
      expect(probs.length).toBe(20);
      probs.forEach((v, i) => expect(Math.abs(v - c.probs![i])).toBeLessThan(1e-4));
      expect(rank(probs)[0].index).toBe(rank(c.probs!)[0].index);
      // AC03: 같은 입력을 다시 넣어도 결과가 같다(제시어는 입력에 없다)
      const again = (await session.run({ input: new ort.Tensor('float32', rasterize(c.strokes), [1, 1, 28, 28]) })).probs.data as Float32Array;
      expect(Array.from(again)).toEqual(Array.from(probs));
    }
    console.log(`추론 시간(개발 PC, 전처리 포함): ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
  }, 30000);
});
