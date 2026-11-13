import type { WorkerLike } from '../src/inference/client';
import type { FromWorker, ToWorker } from '../src/inference/protocol';

/** 테스트용 Worker. 받은 추론 요청을 쌓아 두고, 테스트가 원하는 때에 응답한다. */
export class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = false;

  postMessage(message: ToWorker): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  get infers() {
    return this.sent.filter((m): m is Extract<ToWorker, { type: 'infer' }> => m.type === 'infer');
  }

  lastInfer() {
    return this.infers[this.infers.length - 1];
  }

  respond(id: number, probs: number[]): void {
    this.onmessage?.({ data: { type: 'result', id, probs: Float32Array.from(probs), computeMs: 5 } } as MessageEvent<FromWorker>);
  }

  respondLast(probs: number[]): void {
    this.respond(this.lastInfer().id, probs);
  }

  fail(message: string): void {
    this.onmessage?.({ data: { type: 'error', message } } as MessageEvent<FromWorker>);
  }
}

/** 20종 점수. hot 인덱스에 score, 나머지는 균등 분배. */
export function probs(hot: number, score: number, second?: [number, number]): number[] {
  const p = new Array(20).fill(0);
  p[hot] = score;
  let rest = 1 - score;
  if (second) {
    p[second[0]] = second[1];
    rest -= second[1];
  }
  const others = p.map((v, i) => (v === 0 && i !== hot ? i : -1)).filter((i) => i >= 0);
  for (const i of others) p[i] = rest / others.length;
  return p;
}
