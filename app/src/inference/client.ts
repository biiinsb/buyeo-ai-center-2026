/**
 * 추론 요청 대기열. 진행 중 요청 1개와 최신 대기 입력 1개만 유지한다.
 * 기본 250ms 간격, 최근 20회 왕복 시간 P95가 기준을 넘으면 500ms 로 전환한다.
 * 정상 속도 복귀 여부는 다음 회차 시작(beginRound)에서만 판단한다.
 */
import type { Stroke } from '../preprocess';
import type { FromWorker, ToWorker } from './protocol';

export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface InferTag {
  round: number;
  question: number;
  version: number;
}

export interface InferResult {
  tag: InferTag;
  probs: Float32Array;
  roundTripMs: number;
}

export interface ClientOptions {
  intervalMs: number;
  throttledIntervalMs: number;
  throttleP95Ms: number;
  now?: () => number;
}

const WINDOW = 20;

export function p95(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

type Ready = Extract<FromWorker, { type: 'ready' }>;

interface Job {
  strokes: Stroke[];
  tag: InferTag;
  final?: (r: InferResult | null) => void;
}

export class InferenceClient {
  onResult: (r: InferResult) => void = () => {};
  onError: (message: string) => void = () => {};

  private nextId = 1;
  private inFlight: (Job & { id: number; start: number }) | null = null;
  private pending: Job | null = null;
  private lastStart = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latencies: number[] = [];
  private throttled = false;
  private readonly now: () => number;
  private broken = false;
  private loader: { resolve: (r: Ready) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly worker: WorkerLike, private readonly opts: ClientOptions) {
    this.now = opts.now ?? (() => performance.now());
    worker.onmessage = (e) => this.handle(e.data);
    worker.onerror = (e) => this.fail(e.message || 'Worker 오류');
  }

  get intervalMs(): number {
    return this.throttled ? this.opts.throttledIntervalMs : this.opts.intervalMs;
  }

  get isThrottled(): boolean {
    return this.throttled;
  }

  get recentP95(): number {
    return p95(this.latencies);
  }

  /** 진행 중인 요청이 시작된 시각. 지연 감시용. */
  get inFlightSince(): number | null {
    return this.inFlight ? this.inFlight.start : null;
  }

  /** 모델을 불러오고 시험 추론까지 마친다. */
  load(msg: Extract<ToWorker, { type: 'load' }>, timeoutMs = 20000): Promise<Ready> {
    return new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loader = null;
        reject(new Error('모델 준비 시간 초과'));
      }, timeoutMs);
      this.loader = {
        resolve: (r) => {
          clearTimeout(timer);
          this.loader = null;
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.loader = null;
          reject(e);
        },
      };
      this.worker.postMessage(msg);
    });
  }

  /** 회차 시작. 부하 조절 모드에서 정상 속도로 돌아갈지 판단한다. */
  beginRound(): void {
    if (this.throttled && this.latencies.length >= WINDOW && p95(this.latencies) <= this.opts.throttleP95Ms) this.throttled = false;
    this.cancelPending();
  }

  /** 최신 그림을 대기열에 넣는다. urgent 이면 간격을 기다리지 않는다(손가락을 뗐을 때). */
  submit(strokes: Stroke[], tag: InferTag, urgent = false): void {
    if (this.broken) return;
    this.pending = { strokes, tag };
    this.pump(urgent);
  }

  cancelPending(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 마감 판정용 최종 추론. 대기 입력을 버리고, 진행 중 요청이 끝나면 바로 실행한다.
   * timeoutMs 안에 결과가 없으면 null.
   */
  final(strokes: Stroke[], tag: InferTag, timeoutMs: number): Promise<InferResult | null> {
    this.cancelPending();
    if (this.broken) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: InferResult | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        if (this.pending?.final === finish) this.pending = null;
        finish(null);
      }, timeoutMs);
      const f = this.inFlight;
      if (f && !f.final && f.tag.round === tag.round && f.tag.question === tag.question && f.tag.version === tag.version) {
        // 같은 그림을 이미 계산 중이면 그 결과를 최종 판정에 쓴다.
        f.final = finish;
        return;
      }
      this.pending = { strokes, tag, final: finish };
      this.pump(true);
    });
  }

  dispose(): void {
    this.cancelPending();
    this.inFlight?.final?.(null);
    this.inFlight = null;
    this.broken = true;
    this.worker.terminate();
  }

  private pump(urgent: boolean): void {
    if (this.inFlight || !this.pending || this.broken) return;
    const wait = urgent ? 0 : this.lastStart + this.intervalMs - this.now();
    if (wait > 0) {
      if (!this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        this.pump(false);
      }, wait);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const job = this.pending;
    this.pending = null;
    const id = this.nextId++;
    const start = this.now();
    this.inFlight = { ...job, id, start };
    this.lastStart = start;
    // 획 배열은 복사해서 보낸다(이후 화면 쪽 수정과 분리).
    this.worker.postMessage({ type: 'infer', id, strokes: job.strokes });
  }

  private handle(msg: FromWorker): void {
    if (msg.type === 'ready') return this.loader?.resolve(msg);
    if (msg.type === 'error') return this.fail(msg.message);
    if (msg.type !== 'result' || !this.inFlight || msg.id !== this.inFlight.id) return;
    const job = this.inFlight;
    this.inFlight = null;
    const roundTripMs = this.now() - job.start;
    this.latencies.push(roundTripMs);
    if (this.latencies.length > WINDOW) this.latencies.shift();
    if (!this.throttled && this.latencies.length >= WINDOW && p95(this.latencies) > this.opts.throttleP95Ms) this.throttled = true;
    const result: InferResult = { tag: job.tag, probs: msg.probs, roundTripMs };
    if (job.final) job.final(result);
    else this.onResult(result);
    this.pump(Boolean(this.pending?.final));
  }

  private fail(message: string): void {
    this.loader?.reject(new Error(message));
    if (this.broken) return;
    this.broken = true;
    this.inFlight?.final?.(null);
    this.pending?.final?.(null);
    this.inFlight = null;
    this.cancelPending();
    this.onError(message);
  }
}
