/**
 * 정답 판정. 모델의 20종 전체 점수만 보고 판정하며, 제시어는 모델 입력에 쓰지 않는다.
 */
export interface SuccessRule {
  minScore: number;
  minMargin: number;
  holdMs: number;
}

export interface Ranked {
  index: number;
  score: number;
}

export function rank(probs: ArrayLike<number>): Ranked[] {
  return Array.from(probs, (score, index) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index);
}

/** 최상위 후보가 제시어와 같고, 점수와 1·2위 차이가 기준 이상인가(유지 시간 제외). */
export function meetsRule(probs: ArrayLike<number>, target: number, rule: SuccessRule): boolean {
  const [first, second] = rank(probs);
  if (!first || first.index !== target) return false;
  return first.score >= rule.minScore && first.score - (second?.score ?? 0) >= rule.minMargin;
}

/**
 * 성공 유지 시간 추적. 기준을 만족하는 예측이 연속으로 holdMs 이상 이어지면 성공.
 * 기준을 벗어난 예측, 지우기, 다시 그리기가 오면 처음부터 센다.
 */
export class HoldTracker {
  private since: number | null = null;

  constructor(private readonly rule: SuccessRule) {}

  /** 새 예측을 반영하고, 성공까지 남은 시간(ms)을 돌려준다. 기준 미달이면 null. */
  update(probs: ArrayLike<number>, target: number, now: number): number | null {
    if (!meetsRule(probs, target, this.rule)) {
      this.since = null;
      return null;
    }
    if (this.since === null) this.since = now;
    return Math.max(0, this.since + this.rule.holdMs - now);
  }

  /** 지금 시점에 유지 시간을 채웠는가. */
  satisfied(now: number): boolean {
    return this.since !== null && now - this.since >= this.rule.holdMs;
  }

  reset(): void {
    this.since = null;
  }
}
