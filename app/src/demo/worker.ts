/// <reference lib="webworker" />
/** 체험판 추론 Worker. 메시지 형식은 키오스크 Worker 와 같고, 계산만 순수 JS 로 한다. */
import { rasterize } from '../preprocess';
import type { FromWorker, ToWorker } from '../inference/protocol';
import { JsNet, type WeightsJson } from './jsnet';
import weights from './weights.json';

declare const self: DedicatedWorkerGlobalScope;

let net: JsNet | null = null;
const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      const n = new JsNet(weights as WeightsJson);
      if (n.classes !== msg.classes) throw new Error(`모델 출력 ${n.classes}개 (기대 ${msg.classes})`);
      const w0 = performance.now();
      const probs = n.run(rasterize([[[0, 0], [100, 100]]]));
      const sum = probs.reduce((a, b) => a + b, 0);
      if (!(Math.abs(sum - 1) < 1e-3)) throw new Error('시험 추론 결과 이상');
      net = n;
      post({ type: 'ready', loadMs: w0 - t0, warmupMs: performance.now() - w0, ortVersion: `순수 JS 체험판 (${n.version})` });
      return;
    }
    if (msg.type === 'infer') {
      if (!net) throw new Error('모델이 준비되지 않음');
      const t0 = performance.now();
      const probs = net.run(rasterize(msg.strokes));
      post({ type: 'result', id: msg.id, probs, computeMs: performance.now() - t0 }, [probs.buffer]);
    }
  } catch (error) {
    post({ type: 'error', id: msg.type === 'infer' ? msg.id : undefined, message: String((error as Error)?.message ?? error) });
  }
};
