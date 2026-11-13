import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings';

describe('운영자 설정 검사', () => {
  it('없으면 기본값', () => {
    expect(validateSettings(undefined)).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
  });
  it('범위 안의 값은 반영하고, 벗어난 값은 기본값과 경고', () => {
    const { settings, warnings } = validateSettings({ drawSeconds: 40, questionsPerRound: 50, feedbackAutoSeconds: '6', _comment: 'x', foo: 1 });
    expect(settings.drawSeconds).toBe(40);
    expect(settings.questionsPerRound).toBe(5);
    expect(settings.feedbackAutoSeconds).toBe(6);
    expect(warnings).toHaveLength(3);
  });
  it('부하 조절 간격이 기본 간격보다 짧으면 맞춘다', () => {
    const { settings } = validateSettings({ inferenceIntervalMs: 400, throttledIntervalMs: 300 });
    expect(settings.throttledIntervalMs).toBe(400);
  });
});
