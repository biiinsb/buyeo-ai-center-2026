import { describe, expect, it } from 'vitest';
import { drawQuestions } from '../src/round';

describe('무작위 출제', () => {
  it('AC01: 20개 중 5개를 중복 없이 고른다', () => {
    for (let seed = 0; seed < 500; seed++) {
      const q = drawQuestions(20, 5, seed);
      expect(q).toHaveLength(5);
      expect(new Set(q).size).toBe(5);
      q.forEach((i) => expect(i >= 0 && i < 20).toBe(true));
    }
  });

  it('AC01: 난도순(인덱스순)으로 정렬해 내지 않는다', () => {
    let sorted = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const q = drawQuestions(20, 5, seed);
      if (q.every((v, i) => i === 0 || q[i - 1] < v)) sorted++;
    }
    // 무작위라면 오름차순일 확률은 1/120. 1000회 중 대략 8회.
    expect(sorted).toBeLessThan(30);
  });

  it('AC02: 같은 시드는 같은 회차를 재현한다', () => {
    expect(drawQuestions(20, 5, 12345)).toEqual(drawQuestions(20, 5, 12345));
    expect(drawQuestions(20, 5, 12345)).not.toEqual(drawQuestions(20, 5, 54321));
  });

  it('AC02: 각 키워드의 선택 확률이 5/20으로 같다', () => {
    const N = 40000;
    const count = new Array(20).fill(0);
    const first = new Array(20).fill(0);
    for (let seed = 0; seed < N; seed++) {
      const q = drawQuestions(20, 5, seed * 2654435761);
      q.forEach((i) => count[i]++);
      first[q[0]]++;
    }
    const expected = (N * 5) / 20;
    // 카이제곱(자유도 19), 유의수준 0.001 임계값 43.8
    const chi = count.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(43.8);
    const chiFirst = first.reduce((s, c) => s + (c - N / 20) ** 2 / (N / 20), 0);
    expect(chiFirst).toBeLessThan(43.8);
  });

  it('문제 수 범위를 검사한다', () => {
    expect(() => drawQuestions(20, 0, 1)).toThrow();
    expect(() => drawQuestions(20, 21, 1)).toThrow();
  });
});
