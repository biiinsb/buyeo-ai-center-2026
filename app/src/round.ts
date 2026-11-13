/** 회차 추첨. 20개 클래스를 균등하게 섞고 앞에서 N개를 고른다(PRD '무작위 출제'). */

/** mulberry32: 시드를 고정하면 같은 순서를 재현한다. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 운영 중에는 시드를 매번 새로 뽑는다. */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

/** Fisher-Yates. 원본 배열은 바꾸지 않는다. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 클래스 인덱스 0..classCount-1 중 count개를 중복 없이 고른다.
 * 섞인 순서 그대로 출제하며 난도 정렬이나 가중치를 쓰지 않는다.
 */
export function drawQuestions(classCount: number, count: number, seed: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > classCount) throw new RangeError(`문제 수 ${count} 는 1~${classCount} 이어야 합니다`);
  const all = Array.from({ length: classCount }, (_, i) => i);
  return shuffle(all, createRng(seed)).slice(0, count);
}
