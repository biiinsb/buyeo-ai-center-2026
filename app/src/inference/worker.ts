/// <reference lib="webworker" />
/**
 * 추론 전용 Worker. ONNX Runtime Web 의 WASM CPU 실행, 연산 스레드 1개.
 * WASM 파일은 앱에 동봉한 ort/ 폴더에서만 읽는다.
 */
import * as ort from 'onnxruntime-web/wasm';
import { sha256Hex } from '../bundle';
import { rasterize, RASTER_SPEC } from '../preprocess';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let session: ort.InferenceSession | null = null;
let classes = 0;
const size = RASTER_SPEC.size;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function run(input: Float32Array): Promise<Float32Array> {
  const tensor = new ort.Tensor('float32', input, [1, 1, size, size]);
  const out = await session!.run({ input: tensor });
  const probs = out.probs.data as Float32Array;
  tensor.dispose();
  out.probs.dispose?.();
  if (probs.length !== classes) throw new Error(`모델 출력 ${probs.length}개 (기대 ${classes})`);
  return Float32Array.from(probs);
}

async function load(msg: Extract<ToWorker, { type: 'load' }>) {
  const t0 = performance.now();
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    wasm: new URL('ort-wasm-simd-threaded.wasm', msg.ortBase).href,
    mjs: new URL('ort-wasm-simd-threaded.mjs', msg.ortBase).href,
  };
  const res = await fetch(msg.modelUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`모델 파일을 읽지 못함 (${res.status})`);
  const bytes = await res.arrayBuffer();
  const hash = await sha256Hex(bytes);
  if (hash !== msg.sha256) throw new Error(`모델 체크섬 불일치 ${hash.slice(0, 12)}… != ${msg.sha256.slice(0, 12)}…`);
  classes = msg.classes;
  session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  if (!session.inputNames.includes('input') || !session.outputNames.includes('probs')) throw new Error('모델 입출력 이름이 input/probs 가 아님');
  const loadMs = performance.now() - t0;
  // 시험 추론: 빈 그림과 간단한 선. 점수 합이 1인지 확인한다.
  const w0 = performance.now();
  for (const strokes of [[], [[[0, 0], [100, 100]]]] as const) {
    const probs = await run(rasterize(strokes as unknown as [number, number][][]));
    const sum = probs.reduce((a, b) => a + b, 0);
    if (!(Math.abs(sum - 1) < 1e-3) || !probs.every(Number.isFinite)) throw new Error(`시험 추론 결과 이상 (합 ${sum})`);
  }
  post({ type: 'ready', loadMs, warmupMs: performance.now() - w0, ortVersion: `onnxruntime-web ${ort.env.versions.web ?? 'unknown'} (WASM)` });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') return await load(msg);
    if (msg.type === 'infer') {
      if (!session) throw new Error('모델이 준비되지 않음');
      const t0 = performance.now();
      const probs = await run(rasterize(msg.strokes));
      post({ type: 'result', id: msg.id, probs, computeMs: performance.now() - t0 }, [probs.buffer]);
    }
  } catch (error) {
    post({ type: 'error', id: msg.type === 'infer' ? msg.id : undefined, message: String((error as Error)?.message ?? error) });
  }
};
