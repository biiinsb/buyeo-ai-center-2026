/**
 * 문제 하나의 그림 단계. 30초 타이머, 실시간 예측 반영, 성공 유지 판정,
 * 마감 최종 추론, 추론 지연 시 일시 정지와 기술 오류 종료를 맡는다.
 * 문제 종료(onEnd)는 정확히 한 번만 일어난다.
 */
import type { InferenceClient, InferResult, InferTag } from './inference/client';
import { HoldTracker, meetsRule, rank, type Ranked, type SuccessRule } from './judge';
import { hasEnoughInput, type Stroke } from './preprocess';

export type Outcome = 'recognized' | 'timeout' | 'skipped' | 'empty' | 'error';
export type ChangeKind = 'add' | 'penUp' | 'undo' | 'clear';

export interface GuessView {
  kind: 'empty' | 'unsure' | 'guess' | 'success';
  candidates: Ranked[];
}

export interface QuestionEnd {
  outcome: Outcome;
  lastGuess: number | null;
  strokes: Stroke[];
  drawMs: number;
  error?: string;
}

export interface QuestionHooks {
  onView(view: GuessView): void;
  onTime(remainingMs: number): void;
  onPause(paused: boolean): void;
  onLock(): void;
  onEnd(end: QuestionEnd): void;
  /** 제한 시간이 흐르기 시작한 순간(첫 선을 그었을 때). */
  onClockStart?(): void;
}

export interface QuestionOptions {
  roundId: number;
  questionId: number;
  target: number;
  durationMs: number;
  rule: SuccessRule;
  client: InferenceClient;
  stallPauseMs: number;
  stallFailMs: number;
  finalWaitMs: number;
  hooks: QuestionHooks;
  now?: () => number;
  /** 이 점수보다 낮으면 '아직 잘 모르겠어'를 우선한다. */
  unsureBelow?: number;
  /** 후보 칩으로 보여 줄 최소 점수. */
  candidateMin?: number;
  /** true 면 그리기 화면에 들어온 순간이 아니라 첫 선을 그은 순간부터 시간을 잰다. */
  clockStartsOnFirstStroke?: boolean;
}

const TICK_MS = 100;

function signature(strokes: Stroke[]): string {
  let n = 0;
  for (const s of strokes) n += s.length;
  const last = strokes[strokes.length - 1]?.[strokes[strokes.length - 1].length - 1];
  return `${strokes.length}:${n}:${last?.[0]},${last?.[1]}`;
}

export class QuestionSession {
  private readonly now: () => number;
  private readonly tracker: HoldTracker;
  private strokes: Stroke[] = [];
  private version = 0;
  private minVersion = 0;
  private appliedVersion = -1;
  private lastProbs: Float32Array | null = null;
  private lastSig = '';
  private startedAt = 0;
  private clockRunning = false;
  private pausedTotal = 0;
  private pausedAt: number | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizing = false;
  private ended = false;

  constructor(private readonly o: QuestionOptions) {
    this.now = o.now ?? (() => performance.now());
    this.tracker = new HoldTracker(o.rule);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** 그리기 화면에 들어온 순간. 시계는 바로 또는 첫 선에서 시작한다. */
  start(): void {
    this.o.client.onResult = (r) => this.handleResult(r);
    this.o.client.onError = (m) => this.end('error', m);
    this.o.hooks.onView({ kind: 'empty', candidates: [] });
    this.o.hooks.onTime(this.o.durationMs);
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    if (!this.o.clockStartsOnFirstStroke) this.startClock();
  }

  get isClockRunning(): boolean {
    return this.clockRunning;
  }

  private startClock(): void {
    if (this.clockRunning) return;
    this.clockRunning = true;
    this.startedAt = this.now();
    this.o.hooks.onClockStart?.();
  }

  remainingMs(): number {
    if (!this.clockRunning) return this.o.durationMs;
    const paused = this.pausedTotal + (this.pausedAt !== null ? this.now() - this.pausedAt : 0);
    return Math.max(0, this.o.durationMs - (this.now() - this.startedAt - paused));
  }

  drawingChanged(strokes: Stroke[], kind: ChangeKind): void {
    if (this.ended || this.finalizing) return;
    // 손가락을 떼기만 하고 선이 그대로면 같은 그림을 다시 계산하지 않는다.
    const sig = signature(strokes);
    if ((kind === 'add' || kind === 'penUp') && sig === this.lastSig) return;
    this.lastSig = sig;
    if (strokes.length) this.startClock();
    this.strokes = strokes;
    this.version++;
    if (kind === 'undo' || kind === 'clear') {
      // 지우기 이후에는 이전 후보와 성공 대기를 버린다.
      this.minVersion = this.version;
      this.tracker.reset();
      this.clearHold();
      this.lastProbs = null;
      this.o.client.cancelPending();
    }
    if (!hasEnoughInput(strokes)) {
      this.o.client.cancelPending();
      if (kind !== 'add' || !strokes.length) this.o.hooks.onView({ kind: 'empty', candidates: [] });
      return;
    }
    this.o.client.submit(strokes, this.tag(), kind !== 'add');
  }

  skip(): void {
    if (this.ended || this.finalizing) return;
    this.end('skipped');
  }

  /** 화면 전환 등으로 버릴 때. onEnd 를 부르지 않는다. */
  dispose(): void {
    this.ended = true;
    this.stopTimers();
  }

  private tag(): InferTag {
    return { round: this.o.roundId, question: this.o.questionId, version: this.version };
  }

  private handleResult(r: InferResult): void {
    if (this.ended || this.finalizing) return;
    if (r.tag.round !== this.o.roundId || r.tag.question !== this.o.questionId) return; // 이전 문제의 응답
    if (r.tag.version < this.minVersion || r.tag.version <= this.appliedVersion) return; // 오래된 응답
    this.appliedVersion = r.tag.version;
    this.lastProbs = r.probs;
    const left = this.tracker.update(r.probs, this.o.target, this.now());
    if (left === 0) return this.succeed();
    this.o.hooks.onView(this.view(r.probs, false));
    this.clearHold();
    if (left !== null) {
      // 손가락을 뗀 뒤에도 같은 예측이 유지되면 새 획 없이 성공한다.
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (!this.ended && !this.finalizing && !this.isPaused && this.tracker.satisfied(this.now())) this.succeed();
      }, left);
    }
  }

  private view(probs: Float32Array, success: boolean): GuessView {
    const ranked = rank(probs);
    const candidates = ranked.filter((c, i) => i === 0 || c.score >= (this.o.candidateMin ?? 0.1)).slice(0, 3);
    if (success) return { kind: 'success', candidates };
    if (ranked[0].score < (this.o.unsureBelow ?? 0.4)) return { kind: 'unsure', candidates };
    return { kind: 'guess', candidates };
  }

  private succeed(): void {
    if (this.lastProbs) this.o.hooks.onView(this.view(this.lastProbs, true));
    this.end('recognized');
  }

  private onTick(): void {
    if (this.ended || this.finalizing || !this.clockRunning) return;
    const now = this.now();
    const since = this.o.client.inFlightSince;
    if (since !== null && now - since > this.o.stallFailMs) return this.end('error', '추론 지연이 복구되지 않음');
    if (since !== null && now - since > this.o.stallPauseMs) {
      if (this.pausedAt === null) {
        this.pausedAt = now;
        this.o.hooks.onPause(true);
      }
      return;
    }
    if (this.pausedAt !== null) {
      this.pausedTotal += now - this.pausedAt;
      this.pausedAt = null;
      this.o.hooks.onPause(false);
      if (this.tracker.satisfied(now)) return this.succeed();
    }
    const left = this.remainingMs();
    this.o.hooks.onTime(left);
    if (left <= 0) void this.finalize();
  }

  /** 시간 종료: 그림을 고정하고 마지막 그림으로 최종 추론을 한 번 실행한다(유지 시간 면제). */
  private async finalize(): Promise<void> {
    this.finalizing = true;
    this.clearHold();
    this.o.hooks.onLock();
    if (!hasEnoughInput(this.strokes)) return this.end('empty', undefined, true);
    const r = await this.o.client.final(this.strokes, this.tag(), this.o.finalWaitMs);
    if (this.ended) return;
    if (r && meetsRule(r.probs, this.o.target, this.o.rule)) {
      this.lastProbs = r.probs;
      this.o.hooks.onView(this.view(r.probs, true));
      return this.end('recognized', undefined, true);
    }
    if (r) this.lastProbs = r.probs;
    this.end('timeout', undefined, true);
  }

  private end(outcome: Outcome, error?: string, fromFinal = false): void {
    if (this.ended || (this.finalizing && !fromFinal && outcome !== 'error')) return;
    this.ended = true;
    this.stopTimers();
    if (this.pausedAt !== null) this.o.hooks.onPause(false);
    const lastGuess = outcome === 'recognized' ? this.o.target : this.lastProbs ? rank(this.lastProbs)[0].index : null;
    const drawMs = Math.min(this.o.durationMs, this.o.durationMs - this.remainingMs());
    this.o.client.onResult = () => {};
    this.o.client.onError = () => {};
    this.o.hooks.onEnd({ outcome, lastGuess, strokes: this.strokes, drawMs, error });
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private stopTimers(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.clearHold();
  }
}
