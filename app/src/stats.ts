/**
 * 운영 진단용 로컬 집계. 식별자와 그림 없이 숫자만 남긴다(PRD '데이터 보관과 운영 지표').
 */
import type { Outcome } from './question';

export interface Stats {
  since: string;
  roundsStarted: number;
  roundsCompleted: number;
  roundsErrored: number;
  idleResets: number;
  modelLoadFailures: number;
  inferenceErrors: number;
  roundMsSum: number;
  roundMsCount: number;
  inference: { count: number; sumMs: number; maxMs: number; over150: number };
  keywords: Record<string, Record<Outcome | 'asked', number>>;
  versions: { app: string; model: string };
  lastError?: string;
}

const KEY = 'doodle-detective-stats-v1';

function blank(): Stats {
  return {
    since: new Date().toISOString(),
    roundsStarted: 0,
    roundsCompleted: 0,
    roundsErrored: 0,
    idleResets: 0,
    modelLoadFailures: 0,
    inferenceErrors: 0,
    roundMsSum: 0,
    roundMsCount: 0,
    inference: { count: 0, sumMs: 0, maxMs: 0, over150: 0 },
    keywords: {},
    versions: { app: '', model: '' },
  };
}

export class StatsStore {
  readonly data: Stats;
  private dirty = false;

  constructor() {
    let loaded: Stats | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) loaded = { ...blank(), ...JSON.parse(raw) };
    } catch {
      loaded = null;
    }
    this.data = loaded ?? blank();
    setInterval(() => this.flush(), 10000);
  }

  bump<K extends keyof Stats>(key: K, by = 1): void {
    (this.data[key] as number) += by;
    this.dirty = true;
  }

  outcome(keyword: string, outcome: Outcome | 'asked'): void {
    const row = (this.data.keywords[keyword] ??= { asked: 0, recognized: 0, timeout: 0, skipped: 0, empty: 0, error: 0 });
    row[outcome]++;
    this.dirty = true;
  }

  inference(ms: number): void {
    const s = this.data.inference;
    s.count++;
    s.sumMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (ms > 150) s.over150++;
    this.dirty = true;
  }

  error(message: string): void {
    this.data.lastError = `${new Date().toISOString()} ${message}`;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
      this.dirty = false;
    } catch {
      /* 저장 공간을 쓸 수 없어도 체험은 계속한다 */
    }
  }

  reset(): void {
    Object.assign(this.data, blank(), { versions: this.data.versions });
    this.dirty = true;
    this.flush();
  }
}
