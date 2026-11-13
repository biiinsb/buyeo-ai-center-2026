/** 모델 묶음(bundle.json) 형식과 호환성 검사. 맞지 않으면 체험을 열지 않는다. */
import type { SuccessRule } from './judge';
import { RASTER_SPEC, type RasterSpec } from './preprocess';

export interface Label {
  index: number;
  id: string;
  word: string;
  source: string;
  level: string;
}

export interface ModelBundle {
  bundleFormat: number;
  version: string;
  createdAt: string;
  model: {
    file: string;
    sha256: string;
    bytes: number;
    input: { name: string; shape: number[]; range: [number, number] };
    output: { name: string; classes: number; activation: string };
  };
  preprocess: RasterSpec;
  labels: Label[];
  successRule: SuccessRule;
  metrics?: Record<string, number>;
  dataLicense?: string;
}

export const EXPECTED_CLASS_COUNT = 20;

export function checkBundle(raw: unknown): ModelBundle {
  const b = raw as ModelBundle;
  const fail = (why: string): never => {
    throw new Error(`모델 묶음 오류: ${why}`);
  };
  if (!b || typeof b !== 'object') fail('bundle.json 이 비어 있음');
  if (b.bundleFormat !== 1) fail(`지원하지 않는 bundleFormat ${b.bundleFormat}`);
  if (!b.version) fail('version 없음');
  if (!b.model?.file || !/^[0-9a-f]{64}$/.test(b.model.sha256 ?? '')) fail('model.file 또는 sha256 없음');
  if (b.model.input?.name !== 'input' || b.model.output?.name !== 'probs') fail('입출력 이름이 input/probs 가 아님');
  if (b.model.output.classes !== EXPECTED_CLASS_COUNT) fail(`출력 클래스 수 ${b.model.output.classes} (기대 ${EXPECTED_CLASS_COUNT})`);
  if (!Array.isArray(b.labels) || b.labels.length !== b.model.output.classes) fail(`라벨 수 ${b.labels?.length} 가 출력 클래스 수와 다름`);
  const ids = new Set<string>();
  b.labels.forEach((l, i) => {
    if (l.index !== i) fail(`라벨 ${l.id} 의 index ${l.index} 가 순서 ${i} 와 다름`);
    if (!l.id || !l.word) fail(`라벨 ${i} 의 id/word 없음`);
    if (ids.has(l.id)) fail(`라벨 id 중복 ${l.id}`);
    ids.add(l.id);
  });
  for (const key of Object.keys(RASTER_SPEC) as (keyof RasterSpec)[]) {
    if (b.preprocess?.[key] !== RASTER_SPEC[key]) fail(`전처리 규칙 ${key} 불일치 (${b.preprocess?.[key]} != ${RASTER_SPEC[key]})`);
  }
  const r = b.successRule;
  if (!r || !(r.minScore > 0 && r.minScore <= 1) || !(r.minMargin >= 0 && r.minMargin < 1) || !(r.holdMs >= 0 && r.holdMs <= 5000)) fail('successRule 범위 오류');
  return b;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}
