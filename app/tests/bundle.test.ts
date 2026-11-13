import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkBundle } from '../src/bundle';

const bundlePath = new URL('../public/model/bundle.json', import.meta.url);
const modelPath = new URL('../public/model/model.onnx', import.meta.url);
const hasBundle = existsSync(bundlePath);
const load = () => JSON.parse(readFileSync(bundlePath, 'utf8'));

describe.runIf(hasBundle)('모델 묶음', () => {
  it('동봉된 묶음이 형식 검사를 통과하고 체크섬이 맞다', () => {
    const b = checkBundle(load());
    const hash = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
    expect(hash).toBe(b.model.sha256);
    expect(b.labels.map((l) => l.id)).toEqual([
      'strawberry', 'mushroom', 'grapes', 'ice_cream', 'umbrella', 'pineapple', 'hot_air_balloon', 'snail', 'rabbit', 'penguin',
      'guitar', 'octopus', 'sea_turtle', 'elephant', 'giraffe', 'firetruck', 'helicopter', 'crocodile', 'bicycle', 'kangaroo',
    ]);
  });

  it('AC12: 라벨 수 불일치, 전처리 불일치, 체크섬 형식 오류를 거부한다', () => {
    const b = load();
    expect(() => checkBundle({ ...b, labels: b.labels.slice(0, 19) })).toThrow(/라벨 수/);
    expect(() => checkBundle({ ...b, model: { ...b.model, output: { ...b.model.output, classes: 21 } } })).toThrow(/출력 클래스 수/);
    expect(() => checkBundle({ ...b, preprocess: { ...b.preprocess, halfWidth: 1.2 } })).toThrow(/전처리/);
    expect(() => checkBundle({ ...b, model: { ...b.model, sha256: 'abc' } })).toThrow(/sha256/);
    const dup = structuredClone(b);
    dup.labels[1].id = dup.labels[0].id;
    expect(() => checkBundle(dup)).toThrow(/중복/);
  });
});
