import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceClient } from '../src/inference/client';
import { meetsRule } from '../src/judge';
import type { Stroke } from '../src/preprocess';
import { QuestionSession, type GuessView, type QuestionEnd } from '../src/question';
import { FakeWorker, probs } from './fake-worker';

const RULE = { minScore: 0.75, minMargin: 0.2, holdMs: 600 };
const TARGET = 7; // 달팽이
const OTHER = 4; // 우산
const line = (n = 1): Stroke[] => Array.from({ length: n }, (_, i) => [[0, i * 40], [100, i * 40 + 10]]);

function setup(over: Partial<{ durationMs: number; holdMs: number }> = {}) {
  const worker = new FakeWorker();
  const now = () => Date.now();
  const client = new InferenceClient(worker, { intervalMs: 250, throttledIntervalMs: 500, throttleP95Ms: 150, now });
  const ends: QuestionEnd[] = [];
  const views: GuessView[] = [];
  const pauses: boolean[] = [];
  let locked = false;
  const q = new QuestionSession({
    roundId: 1,
    questionId: 0,
    target: TARGET,
    durationMs: over.durationMs ?? 30000,
    rule: { ...RULE, holdMs: over.holdMs ?? RULE.holdMs },
    client,
    stallPauseMs: 1000,
    stallFailMs: 5000,
    finalWaitMs: 1000,
    now,
    hooks: {
      onView: (v) => views.push(v),
      onTime: () => {},
      onPause: (p) => pauses.push(p),
      onLock: () => (locked = true),
      onEnd: (e) => ends.push(e),
    },
  });
  q.start();
  return { worker, client, q, ends, views, pauses, isLocked: () => locked };
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('판정 규칙', () => {
  it('최상위가 제시어이고 점수·차이 기준을 넘어야 한다', () => {
    expect(meetsRule(probs(TARGET, 0.8), TARGET, RULE)).toBe(true);
    expect(meetsRule(probs(TARGET, 0.7), TARGET, RULE)).toBe(false);
    expect(meetsRule(probs(TARGET, 0.76, [OTHER, 0.6 - 0.02]), TARGET, RULE)).toBe(false);
  });

  it('AC05: 제시어와 다른 그림이 높은 점수여도 성공이 아니다', () => {
    expect(meetsRule(probs(OTHER, 0.99), TARGET, RULE)).toBe(false);
  });

  it('AC03: 추론 요청에는 제시어가 들어가지 않는다', () => {
    const { worker, q } = setup();
    q.drawingChanged(line(), 'penUp');
    const msg = worker.lastInfer();
    expect(Object.keys(msg).sort()).toEqual(['id', 'strokes', 'type']);
    expect(JSON.stringify(msg)).not.toContain(String(TARGET) + ',');
  });
});

describe('문제 진행', () => {
  it('기준을 600ms 유지하면 알아봄으로 끝난다', () => {
    const { worker, q, ends } = setup();
    q.drawingChanged(line(), 'penUp');
    worker.respondLast(probs(TARGET, 0.9));
    vi.advanceTimersByTime(599);
    expect(ends).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(ends).toEqual([expect.objectContaining({ outcome: 'recognized', lastGuess: TARGET })]);
  });

  it('유지 시간 2초: 그리는 동안 정답 예상이 2초 이어져야 성공한다', () => {
    const { worker, q, ends } = setup({ holdMs: 2000 });
    q.drawingChanged(line(1), 'penUp');
    worker.respondLast(probs(TARGET, 0.9));
    vi.advanceTimersByTime(1000);
    q.drawingChanged(line(2), 'penUp'); // 계속 그림
    worker.respondLast(probs(TARGET, 0.85));
    vi.advanceTimersByTime(999);
    expect(ends).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(ends[0]?.outcome).toBe('recognized');
  });

  it('AC08: 손가락을 뗀 뒤 새 획 없이도 유지 시간이 지나면 성공한다', () => {
    const { worker, q, ends } = setup();
    q.drawingChanged(line(), 'add');
    q.drawingChanged(line(), 'penUp');
    expect(worker.infers).toHaveLength(1);
    worker.respondLast(probs(TARGET, 0.95));
    vi.advanceTimersByTime(700);
    expect(worker.infers).toHaveLength(1); // 같은 그림을 반복 계산하지 않는다
    expect(ends[0]?.outcome).toBe('recognized');
  });

  it('AC06: 획을 지우면 성공 대기와 오래된 예측을 버린다', () => {
    const { worker, q, ends, views } = setup();
    q.drawingChanged(line(2), 'penUp');
    const before = worker.lastInfer().id;
    q.drawingChanged(line(1), 'undo');
    worker.respond(before, probs(TARGET, 0.95)); // 지우기 전 그림의 응답
    vi.advanceTimersByTime(1000);
    expect(ends).toHaveLength(0);
    expect(views.some((v) => v.kind === 'success')).toBe(false);
    // 지운 뒤 그림의 응답은 반영된다
    vi.advanceTimersByTime(300);
    worker.respondLast(probs(OTHER, 0.9));
    expect(views[views.length - 1]).toMatchObject({ kind: 'guess', candidates: [expect.objectContaining({ index: OTHER })] });
  });

  it('AC06: 기준을 벗어난 예측이 오면 유지 시간을 처음부터 센다', () => {
    const { worker, q, ends } = setup();
    q.drawingChanged(line(1), 'penUp');
    worker.respondLast(probs(TARGET, 0.9));
    vi.advanceTimersByTime(400);
    q.drawingChanged(line(2), 'penUp');
    worker.respondLast(probs(OTHER, 0.6));
    vi.advanceTimersByTime(400);
    expect(ends).toHaveLength(0);
    q.drawingChanged(line(3), 'penUp');
    worker.respondLast(probs(TARGET, 0.9));
    vi.advanceTimersByTime(599);
    expect(ends).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(ends[0]?.outcome).toBe('recognized');
  });

  it('이전 문제의 응답은 버린다', () => {
    const { client, ends, views } = setup();
    client.onResult({ tag: { round: 1, question: 99, version: 1 }, probs: Float32Array.from(probs(TARGET, 0.99)), roundTripMs: 5 });
    client.onResult({ tag: { round: 0, question: 0, version: 1 }, probs: Float32Array.from(probs(TARGET, 0.99)), roundTripMs: 5 });
    vi.advanceTimersByTime(1000);
    expect(ends).toHaveLength(0);
    expect(views.every((v) => v.kind === 'empty')).toBe(true);
  });

  it('AC04: 아무것도 그리지 않으면 판정 없이 빈 그림으로 끝난다', () => {
    const { worker, ends } = setup();
    vi.advanceTimersByTime(30100);
    expect(worker.infers).toHaveLength(0);
    expect(ends).toEqual([expect.objectContaining({ outcome: 'empty', lastGuess: null })]);
  });

  it('시간 종료: 마지막 그림으로 최종 추론하고 유지 시간 없이 판정한다', async () => {
    const { worker, q, ends, isLocked } = setup();
    q.drawingChanged(line(), 'penUp');
    worker.respondLast(probs(OTHER, 0.5));
    vi.advanceTimersByTime(29950);
    q.drawingChanged(line(2), 'add'); // 마감 직전 획
    vi.advanceTimersByTime(100);
    expect(isLocked()).toBe(true);
    const final = worker.lastInfer();
    expect(final.strokes).toHaveLength(2);
    worker.respond(final.id, probs(TARGET, 0.8));
    await vi.runOnlyPendingTimersAsync();
    expect(ends).toEqual([expect.objectContaining({ outcome: 'recognized' })]);
  });

  it('시간 종료: 최종 추론이 기준 미달이면 마지막 추측을 남긴다', async () => {
    const { worker, q, ends } = setup();
    q.drawingChanged(line(), 'penUp');
    worker.respondLast(probs(OTHER, 0.6));
    vi.advanceTimersByTime(30050);
    expect(worker.infers).toHaveLength(2); // 마감 시 최종 추론 1회
    worker.respondLast(probs(OTHER, 0.7));
    await vi.runOnlyPendingTimersAsync();
    expect(ends).toEqual([expect.objectContaining({ outcome: 'timeout', lastGuess: OTHER })]);
  });

  it('AC07: 성공 유지 시점과 시간 종료가 겹쳐도 종료는 한 번이다', async () => {
    const { worker, q, ends } = setup();
    vi.advanceTimersByTime(29300);
    q.drawingChanged(line(), 'penUp');
    worker.respondLast(probs(TARGET, 0.9)); // 600ms 뒤 = 29,900ms, 마감 30,000ms 근처
    vi.advanceTimersByTime(800);
    // 최종 추론 응답이 늦게 와도 추가 종료가 없다
    if (worker.infers.length > 1) worker.respondLast(probs(TARGET, 0.9));
    await vi.runAllTimersAsync();
    expect(ends).toHaveLength(1);
    expect(ends[0].outcome).toBe('recognized');
  });

  it('AC10: 건너뛰기는 문제를 소비하고 한 번만 끝난다', () => {
    const { q, ends } = setup();
    q.skip();
    q.skip();
    expect(ends).toEqual([expect.objectContaining({ outcome: 'skipped' })]);
  });

  it('AC13: 추론이 1초 넘게 걸리면 타이머를 멈추고, 복구되면 남은 시간을 이어 간다', () => {
    const { worker, q, ends, pauses } = setup();
    vi.advanceTimersByTime(10000);
    q.drawingChanged(line(), 'penUp');
    vi.advanceTimersByTime(3000); // 응답 없음
    expect(pauses).toEqual([true]);
    const remainingWhilePaused = q.remainingMs();
    vi.advanceTimersByTime(500);
    expect(q.remainingMs()).toBe(remainingWhilePaused);
    worker.respondLast(probs(OTHER, 0.5));
    vi.advanceTimersByTime(200);
    expect(pauses).toEqual([true, false]);
    expect(ends).toHaveLength(0);
    // 멈춘 시간(약 2.6초)은 빼고 센다: 진행 11.2초 -> 남은 18.8초
    expect(q.remainingMs()).toBe(18800);
  });

  it('AC13: 5초 넘게 복구되지 않으면 기술 오류로 끝난다', () => {
    const { q, ends } = setup();
    q.drawingChanged(line(), 'penUp');
    vi.advanceTimersByTime(5200);
    expect(ends).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('AC13: Worker 오류는 기술 오류로 끝나고 그림은 남는다', () => {
    const { worker, q, ends } = setup();
    q.drawingChanged(line(2), 'penUp');
    worker.fail('boom');
    expect(ends).toEqual([expect.objectContaining({ outcome: 'error', error: 'boom' })]);
    expect(ends[0].strokes).toHaveLength(2);
  });
});

describe('추론 대기열', () => {
  it('진행 중 1개와 최신 입력 1개만 유지한다', () => {
    const { worker, q } = setup();
    q.drawingChanged(line(1), 'penUp');
    q.drawingChanged(line(2), 'add');
    q.drawingChanged(line(3), 'add');
    q.drawingChanged(line(4), 'add');
    expect(worker.infers).toHaveLength(1);
    worker.respondLast(probs(OTHER, 0.3));
    vi.advanceTimersByTime(300);
    expect(worker.infers).toHaveLength(2);
    expect(worker.lastInfer().strokes).toHaveLength(4);
  });

  it('기본 250ms 간격, 최근 20회 P95가 150ms 를 넘으면 500ms 로 바꾸고 다음 회차에 되돌린다', () => {
    const { worker, client, q } = setup();
    for (let i = 0; i < 20; i++) {
      q.drawingChanged(line((i % 3) + 1), 'penUp');
      vi.advanceTimersByTime(200);
      worker.respondLast(probs(OTHER, 0.3));
      vi.advanceTimersByTime(300);
    }
    expect(client.isThrottled).toBe(true);
    expect(client.intervalMs).toBe(500);
    client.beginRound();
    expect(client.isThrottled).toBe(true); // 아직 느림
    for (let i = 0; i < 20; i++) {
      q.drawingChanged(line((i % 3) + 1), 'penUp');
      worker.respondLast(probs(OTHER, 0.3));
      vi.advanceTimersByTime(600);
    }
    client.beginRound();
    expect(client.isThrottled).toBe(false);
  });
});
