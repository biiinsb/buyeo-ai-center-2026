/**
 * 체험판 추론 엔진. 키오스크 Worker 와 같은 메시지 형식을 쓰지만 페이지 안에서 실행한다.
 * Chrome 은 file:// 로 연 페이지에서 Worker 스크립트를 막기 때문에(교차 출처 정책)
 * 단일 HTML 체험판은 별도 Worker 없이 계산한다. 한 번에 약 40ms 라 그리기 반응에는 지장이 작다.
 */
import type { WorkerLike } from '../inference/client';
import type { FromWorker, ToWorker } from '../inference/protocol';
import { rasterize } from '../preprocess';
import { JsNet, type WeightsJson } from './jsnet';
import weights from './weights.json';

export class InlineEngine implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private net: JsNet | null = null;
  private stopped = false;

  postMessage(message: ToWorker): void {
    // 실제 Worker 처럼 비동기로 처리해 화면 갱신이 먼저 일어나게 한다.
    setTimeout(() => {
      if (!this.stopped) this.handle(message);
    }, 0);
  }

  terminate(): void {
    this.stopped = true;
    this.net = null;
  }

  private post(msg: FromWorker): void {
    if (!this.stopped) this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  }

  private handle(msg: ToWorker): void {
    try {
      if (msg.type === 'load') {
        const t0 = performance.now();
        const n = new JsNet(weights as WeightsJson);
        if (n.classes !== msg.classes) throw new Error(`모델 출력 ${n.classes}개 (기대 ${msg.classes})`);
        const w0 = performance.now();
        const probs = n.run(rasterize([[[0, 0], [100, 100]]]));
        const sum = probs.reduce((a, b) => a + b, 0);
        if (!(Math.abs(sum - 1) < 1e-3)) throw new Error('시험 추론 결과 이상');
        this.net = n;
        this.post({ type: 'ready', loadMs: w0 - t0, warmupMs: performance.now() - w0, ortVersion: `순수 JS 체험판 (${n.version})` });
        return;
      }
      if (msg.type === 'infer') {
        if (!this.net) throw new Error('모델이 준비되지 않음');
        const t0 = performance.now();
        const probs = this.net.run(rasterize(msg.strokes));
        this.post({ type: 'result', id: msg.id, probs, computeMs: performance.now() - t0 });
      }
    } catch (error) {
      this.post({ type: 'error', id: msg.type === 'infer' ? msg.id : undefined, message: String((error as Error)?.message ?? error) });
    }
  }
}
