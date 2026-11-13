/**
 * 운영자 설정. settings.json 의 값을 범위 검사하고, 벗어난 값은 기본값으로 되돌린다.
 * 학생 화면에는 노출하지 않는다.
 */
export interface Settings {
  questionsPerRound: number;
  drawSeconds: number;
  feedbackAutoSeconds: number;
  resultAutoSeconds: number;
  idlePromptSeconds: number;
  idleConfirmSeconds: number;
  inferenceIntervalMs: number;
  throttledIntervalMs: number;
  throttleP95Ms: number;
  stallPauseMs: number;
  stallFailMs: number;
  finalWaitMs: number;
  /** 정답 예상이 이만큼 이어져야 그리는 중 성공으로 본다. 모델 묶음의 holdMs 를 대신한다. */
  successHoldMs: number;
}

type Range = readonly [min: number, max: number, integer: boolean];

export const DEFAULT_SETTINGS: Settings = {
  questionsPerRound: 5,
  drawSeconds: 30,
  feedbackAutoSeconds: 6,
  resultAutoSeconds: 45,
  idlePromptSeconds: 60,
  idleConfirmSeconds: 10,
  inferenceIntervalMs: 250,
  throttledIntervalMs: 500,
  throttleP95Ms: 150,
  stallPauseMs: 1000,
  stallFailMs: 5000,
  finalWaitMs: 1000,
  successHoldMs: 2000,
};

const RANGES: Record<keyof Settings, Range> = {
  questionsPerRound: [1, 20, true],
  drawSeconds: [10, 120, true],
  feedbackAutoSeconds: [3, 30, true],
  resultAutoSeconds: [10, 180, true],
  idlePromptSeconds: [20, 600, true],
  idleConfirmSeconds: [5, 60, true],
  inferenceIntervalMs: [100, 2000, true],
  throttledIntervalMs: [100, 3000, true],
  throttleP95Ms: [20, 2000, true],
  stallPauseMs: [300, 5000, true],
  stallFailMs: [1000, 30000, true],
  finalWaitMs: [200, 5000, true],
  successHoldMs: [0, 10000, true],
};

export function validateSettings(input: unknown): { settings: Settings; warnings: string[] } {
  const settings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  if (input === undefined || input === null) return { settings, warnings };
  if (typeof input !== 'object' || Array.isArray(input)) return { settings, warnings: ['settings.json 이 객체가 아닙니다. 기본값을 씁니다.'] };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // 주석용 키
    if (!(key in RANGES)) {
      warnings.push(`알 수 없는 설정 ${key} 를 무시합니다.`);
      continue;
    }
    const k = key as keyof Settings;
    const [min, max, integer] = RANGES[k];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      warnings.push(`${key}=${JSON.stringify(value)} 는 ${min}~${max} 범위가 아닙니다. 기본값 ${DEFAULT_SETTINGS[k]} 을 씁니다.`);
      continue;
    }
    settings[k] = value;
  }
  if (settings.throttledIntervalMs < settings.inferenceIntervalMs) {
    warnings.push('throttledIntervalMs 가 inferenceIntervalMs 보다 짧습니다. 같은 값으로 맞춥니다.');
    settings.throttledIntervalMs = settings.inferenceIntervalMs;
  }
  if (settings.stallFailMs <= settings.stallPauseMs) {
    warnings.push('stallFailMs 는 stallPauseMs 보다 길어야 합니다. 기본값을 씁니다.');
    settings.stallPauseMs = DEFAULT_SETTINGS.stallPauseMs;
    settings.stallFailMs = DEFAULT_SETTINGS.stallFailMs;
  }
  return { settings, warnings };
}
