import './styles.css';
import { checkBundle, type ModelBundle } from './bundle';
import { InferenceClient } from './inference/client';
import type { Ranked } from './judge';
import { DrawingPad, drawStrokes } from './pad';
import { createWorker, loadMessage, readBundle, readSettings } from './platform';
import type { Stroke } from './preprocess';
import { QuestionSession, type GuessView, type Outcome, type QuestionEnd } from './question';
import { drawQuestions, randomSeed } from './round';
import { DEFAULT_SETTINGS, validateSettings, type Settings } from './settings';
import { StatsStore } from './stats';

declare const __APP_VERSION__: string;

type Screen = 'loading' | 'idle' | 'intro' | 'guide' | 'prompt' | 'draw' | 'feedback' | 'result';

interface QuestionResult {
  target: number;
  outcome: Outcome;
  lastGuess: number | null;
  strokes: Stroke[];
}

interface Round {
  id: number;
  seed: number;
  targets: number[];
  index: number;
  results: QuestionResult[];
  startedAt: number;
  error: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings = DEFAULT_SETTINGS;
let settingsWarnings: string[] = [];
let bundle: ModelBundle | null = null;
let client: InferenceClient | null = null;
let ortVersion = '';
let lastReady = '';
let round: Round | null = null;
let roundCounter = 0;
let question: QuestionSession | null = null;
let screen: Screen = 'loading';
let screenTimers: ReturnType<typeof setTimeout>[] = [];
let busy = false; // 화면 전환 중 중복 터치 방지
const stats = new StatsStore();
const pad = new DrawingPad($<HTMLCanvasElement>('pad'));

/* ---------- 화면 배율과 제스처 차단 ---------- */

function fit(): void {
  const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  document.documentElement.style.setProperty('--scale', String(scale));
  requestAnimationFrame(() => pad.resize());
}
window.addEventListener('resize', fit);
fit();
for (const type of ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu', 'selectstart', 'dragstart'])
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

/* ---------- 공통 ---------- */

const word = (index: number) => bundle!.labels[index].word;

function hasBatchim(text: string): boolean {
  const c = text.charCodeAt(text.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
}

function later(fn: () => void, ms: number): void {
  screenTimers.push(setTimeout(fn, ms));
}

function countdown(el: HTMLElement, seconds: number, text: (s: number) => string, done: () => void): void {
  let left = seconds;
  el.textContent = text(left);
  const step = () => {
    left--;
    if (left <= 0) return done();
    el.textContent = text(left);
    later(step, 1000);
  };
  later(step, 1000);
}

function show(next: Screen): void {
  for (const t of screenTimers) clearTimeout(t);
  screenTimers = [];
  screen = next;
  document.body.dataset.screen = next;
  busy = false;
  // 그리기 화면은 첫 선을 긋기 전까지만 무조작 감시(시간이 흐르지 않으므로)
  idle.arm(next === 'intro' || next === 'guide' || next === 'prompt' || next === 'draw');
}

/** 버튼은 손을 뗄 때(click) 동작하며, 그림을 그리는 중이거나 화면 전환 중이면 무시한다. */
function onTap(id: string, handler: () => void, opts: { once?: boolean } = { once: true }): void {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    if (pad.isDrawing || ($(id) as HTMLButtonElement).disabled) return;
    if (opts.once) {
      if (busy) return;
      busy = true;
    }
    idle.poke();
    handler();
  });
}

/* ---------- 무조작 감시: 안내·제시어 화면에서 60초 → 계속할까요 → 10초 → 정리 ---------- */

const idle = (() => {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  const dialog = $('idle-dialog');
  const close = () => {
    dialog.hidden = true;
    if (tick) clearInterval(tick);
    tick = null;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = armed ? setTimeout(open, settings.idlePromptSeconds * 1000) : null;
  };
  const open = () => {
    let left = settings.idleConfirmSeconds;
    $('idle-count').textContent = String(left);
    dialog.hidden = false;
    tick = setInterval(() => {
      left--;
      $('idle-count').textContent = String(Math.max(0, left));
      if (left <= 0) {
        close();
        stats.bump('idleResets');
        endRound();
        show('idle');
      }
    }, 1000);
  };
  $('btn-continue').addEventListener('click', () => {
    close();
    schedule();
  });
  document.addEventListener('pointerdown', () => !dialog.hidden || schedule(), { passive: true });
  return {
    arm(on: boolean) {
      armed = on;
      close();
      schedule();
    },
    poke: schedule,
  };
})();

/* ---------- 준비: 설정, 모델 묶음, Worker ---------- */

async function loadSettings(): Promise<void> {
  try {
    const raw = await readSettings();
    ({ settings, warnings: settingsWarnings } = validateSettings(raw.data));
    if (!raw.found) settingsWarnings.push('settings.json 이 없어 기본값을 씁니다.');
  } catch (error) {
    settings = DEFAULT_SETTINGS;
    settingsWarnings = [`settings.json 을 읽지 못해 기본값을 씁니다: ${(error as Error).message}`];
  }
}

async function prepare(): Promise<void> {
  show('loading');
  $('loading-title').textContent = '그림 친구를 깨우는 중이에요';
  $('loading-text').textContent = '잠시만 기다려 주세요.';
  $('loading-spinner').hidden = false;
  $('btn-retry').hidden = true;
  $('loading-diag').hidden = true;
  client?.dispose();
  client = null;
  try {
    bundle = checkBundle(await readBundle());
    const c = new InferenceClient(createWorker(), {
      intervalMs: settings.inferenceIntervalMs,
      throttledIntervalMs: settings.throttledIntervalMs,
      throttleP95Ms: settings.throttleP95Ms,
    });
    const ready = await c.load(loadMessage(bundle));
    client = c;
    ortVersion = ready.ortVersion;
    lastReady = `load ${ready.loadMs.toFixed(0)}ms, warmup ${ready.warmupMs.toFixed(0)}ms`;
    stats.data.versions = { app: __APP_VERSION__, model: bundle.version };
    show('idle');
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    stats.bump('modelLoadFailures');
    stats.error(message);
    $('loading-title').textContent = '그림 친구를 준비하지 못했어요';
    $('loading-text').textContent = '아래 버튼을 눌러 다시 준비해 주세요.';
    $('loading-spinner').hidden = true;
    $('btn-retry').hidden = false;
    $('loading-diag').hidden = false;
    $('loading-diag').textContent = message;
    busy = false;
  }
}

/* ---------- 회차 ---------- */

/** 새 회차. 처음 시작하면 머신러닝 소개부터, 다시 체험이면 게임 방법부터 보여 준다. */
function startRound(withIntro = true): void {
  endRound();
  const seed = randomSeed();
  round = {
    id: ++roundCounter,
    seed,
    targets: drawQuestions(bundle!.labels.length, settings.questionsPerRound, seed),
    index: 0,
    results: [],
    startedAt: performance.now(),
    error: false,
  };
  client!.beginRound();
  stats.bump('roundsStarted');
  show(withIntro ? 'intro' : 'guide');
}

/** 회차 정리. 그림과 예측에 대한 참조를 모두 버린다. */
function endRound(): void {
  question?.dispose();
  question = null;
  round = null;
  pad.clear(true);
  $('cards').replaceChildren();
  paintThumb($<HTMLCanvasElement>('fb-thumb'), []);
  stats.flush();
}

function showPrompt(): void {
  const r = round!;
  $('prompt-count').textContent = `${r.index + 1}번째 그림 / ${r.targets.length}`;
  $('prompt-word').textContent = word(r.targets[r.index]);
  show('prompt');
}

function startDrawing(): void {
  const r = round!;
  const target = r.targets[r.index];
  $('draw-count').textContent = `${r.index + 1} / ${r.targets.length}`;
  $('draw-word').textContent = word(target);
  $('pause').hidden = true;
  $('paper').classList.remove('locked');
  pad.clear(true);
  show('draw');
  pad.resize();
  for (const id of ['btn-undo', 'btn-clear', 'btn-skip']) ($(id) as HTMLButtonElement).disabled = false;
  bubble.reset();
  $('paper-hint').hidden = false;
  $('timer').classList.add('waiting');
  stats.outcome(bundle!.labels[target].id, 'asked');

  const q = new QuestionSession({
    roundId: r.id,
    questionId: r.index,
    target,
    durationMs: settings.drawSeconds * 1000,
    // 점수 기준은 모델 묶음, 유지 시간은 운영자 설정(그리는 시간을 넉넉히 주기 위해)을 따른다.
    rule: { ...bundle!.successRule, holdMs: settings.successHoldMs },
    clockStartsOnFirstStroke: true,
    client: client!,
    stallPauseMs: settings.stallPauseMs,
    stallFailMs: settings.stallFailMs,
    finalWaitMs: settings.finalWaitMs,
    hooks: {
      onView: (v) => bubble.set(v),
      onTime: (ms) => renderTime(ms),
      onPause: (paused) => {
        $('pause').hidden = !paused;
        pad.setLocked(paused);
      },
      onLock: () => lockDrawing(),
      onClockStart: () => {
        $('paper-hint').hidden = true;
        $('timer').classList.remove('waiting');
        idle.arm(false);
      },
      onEnd: (end) => finishQuestion(q, end),
    },
  });
  question = q;
  pad.onChange = (strokes, kind) => q.drawingChanged(strokes, kind);
  q.start();
  // 추론 시간 기록(통계용)
  const handler = client!.onResult;
  client!.onResult = (res) => {
    stats.inference(res.roundTripMs);
    handler(res);
  };
  pad.setLocked(false);
}

function lockDrawing(): void {
  pad.setLocked(true);
  $('paper').classList.add('locked');
  for (const id of ['btn-undo', 'btn-clear', 'btn-skip']) ($(id) as HTMLButtonElement).disabled = true;
}

function renderTime(ms: number): void {
  const total = settings.drawSeconds * 1000;
  const s = Math.ceil(ms / 1000);
  $('timer-num').textContent = String(s);
  $('timer').classList.toggle('low', s <= 5);
  $('timebar').parentElement!.classList.toggle('low', s <= 5);
  $('timebar').style.transform = `scaleX(${Math.max(0, ms / total)})`;
}

function finishQuestion(q: QuestionSession, end: QuestionEnd): void {
  if (q !== question || !round) return;
  question = null;
  lockDrawing();
  pad.onChange = () => {};
  const r = round;
  const target = r.targets[r.index];
  r.results.push({ target, outcome: end.outcome, lastGuess: end.lastGuess, strokes: end.strokes });
  stats.outcome(bundle!.labels[target].id, end.outcome);
  if (end.outcome === 'error') {
    r.error = true;
    stats.bump('inferenceErrors');
    stats.error(end.error ?? 'inference error');
    return showResult();
  }
  if (end.outcome === 'recognized') {
    // 성공 문구를 잠깐 보여 준 뒤 피드백으로 넘어간다.
    later(() => showFeedback(), 900);
  } else if (end.outcome === 'timeout') {
    bubble.text('이번에는 내가 알아보지 못했어. 다음 그림도 만나 보자!');
    later(() => showFeedback(), 900);
  } else showFeedback();
}

/* ---------- AI 말풍선: 대표 후보가 깜빡이지 않게 최소 간격을 둔다 ---------- */

const bubble = (() => {
  const el = $('bubble-text');
  const chips = $('chips');
  let lastChange = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const MIN_GAP = 450;

  const render = (v: GuessView) => {
    const top = v.candidates[0];
    let text: string;
    if (v.kind === 'empty') text = '몇 획 그려 주면 내가 맞혀 볼게!';
    else if (v.kind === 'unsure') text = '아직 잘 모르겠어. 특징을 더 그려 줄래?';
    else if (v.kind === 'success') text = `아하, ${word(top.index)}${hasBatchim(word(top.index)) ? '이구나' : '구나'}!`;
    else text = `혹시 ${word(top.index)}일까?`;
    el.textContent = text;
    el.parentElement!.classList.toggle('success', v.kind === 'success');
    renderChips(v.kind === 'empty' ? [] : v.candidates, v.kind === 'unsure');
    lastChange = performance.now();
  };

  const renderChips = (list: Ranked[], dim: boolean) => {
    chips.replaceChildren();
    chips.classList.toggle('dim', dim);
    if (!list.length) return;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = dim ? '떠오르는 후보' : 'AI의 후보';
    chips.append(label);
    list.forEach((c, i) => {
      const chip = document.createElement('span');
      chip.className = i === 0 && !dim ? 'chip first' : 'chip';
      chip.textContent = word(c.index);
      chips.append(chip);
    });
  };

  return {
    set(v: GuessView) {
      if (pending) clearTimeout(pending);
      pending = null;
      const wait = lastChange + MIN_GAP - performance.now();
      if (v.kind === 'success' || v.kind === 'empty' || wait <= 0) return render(v);
      pending = setTimeout(() => {
        pending = null;
        if (screen === 'draw') render(v);
      }, wait);
    },
    text(t: string) {
      if (pending) clearTimeout(pending);
      pending = null;
      el.textContent = t;
      el.parentElement!.classList.remove('success');
    },
    reset() {
      if (pending) clearTimeout(pending);
      pending = null;
      lastChange = 0;
      render({ kind: 'empty', candidates: [] });
    },
  };
})();

/* ---------- 피드백과 결과 ---------- */

const STATUS: Record<Outcome, { pill: string; title: string }> = {
  recognized: { pill: '알아봤어요', title: 'AI가 알아봤어요!' },
  timeout: { pill: '아직 못 알아봤어요', title: '이번에는 AI가 헷갈렸어요' },
  skipped: { pill: '건너뛰었어요', title: '다음 그림으로 가 볼까요?' },
  empty: { pill: '그림이 없어요', title: '이번에는 그림이 없었어요' },
  error: { pill: '잠시 멈췄어요', title: '그림 친구가 잠시 멈췄어요' },
};

function paintThumb(canvas: HTMLCanvasElement, strokes: Stroke[]): void {
  const [w, h] = pad.size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fffdf9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!strokes.length || !w) return;
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  drawStrokes(tmp.getContext('2d')!, strokes, tmp.width, tmp.height, w, h, pad.lineWidth, pad.color);
  ctx.drawImage(tmp, 0, 0);
}

function showFeedback(): void {
  const r = round!;
  const res = r.results[r.results.length - 1];
  const last = r.index + 1 >= r.targets.length;
  const st = STATUS[res.outcome];
  $('fb-count').textContent = `${r.index + 1}번째 그림 / ${r.targets.length}`;
  $('fb-status').textContent = st.pill;
  $('fb-status').className = `status-pill status-${res.outcome}`;
  $('fb-title').textContent = st.title;
  $('fb-word').textContent = word(res.target);
  paintThumb($<HTMLCanvasElement>('fb-thumb'), res.strokes);
  $('fb-guess').textContent =
    res.outcome === 'timeout'
      ? res.lastGuess !== null
        ? `AI의 마지막 추측: ${word(res.lastGuess)}`
        : 'AI가 아직 떠올린 그림이 없었어요.'
      : res.outcome === 'recognized'
        ? '그림의 특징을 잘 찾아냈어요.'
        : '';
  $('btn-next').textContent = last ? '결과 보기' : '다음 그림';
  show('feedback');
  countdown($('fb-auto'), settings.feedbackAutoSeconds, (s) => `${s}초 뒤 자동으로 넘어가요`, nextQuestion);
}

function nextQuestion(): void {
  const r = round;
  if (!r || screen !== 'feedback') return;
  r.index++;
  if (r.index >= r.targets.length) showResult();
  else showPrompt();
}

function showResult(): void {
  const r = round!;
  // 결과 화면에 도달하면 회차 완료로 센다(PRD 정상 완료율 정의).
  stats.bump(r.error ? 'roundsErrored' : 'roundsCompleted');
  if (!r.error) {
    stats.bump('roundMsSum', performance.now() - r.startedAt);
    stats.bump('roundMsCount');
  }
  stats.flush();
  const recognized = r.results.filter((x) => x.outcome === 'recognized').length;
  $('result-title').textContent = recognized ? `AI가 알아본 그림 ${recognized}개` : 'AI에게 어려운 그림들이었어요';
  $('result-error').hidden = !r.error;
  const cards = $('cards');
  cards.replaceChildren();
  for (const res of r.results) {
    const card = document.createElement('div');
    card.className = 'card';
    const c = document.createElement('canvas');
    c.width = 260;
    c.height = 260;
    paintThumb(c, res.strokes);
    const name = document.createElement('strong');
    name.textContent = word(res.target);
    const pill = document.createElement('span');
    pill.className = `status-pill status-${res.outcome}`;
    pill.textContent = STATUS[res.outcome].pill;
    card.append(c, name, pill);
    cards.append(card);
  }
  show('result');
  countdown($('result-auto'), settings.resultAutoSeconds, (s) => `${s}초 뒤 처음 화면으로 돌아가요`, () => leaveResult(false));
}

function leaveResult(again: boolean): void {
  if (screen !== 'result') return;
  const hadError = round?.error ?? false;
  endRound();
  if (hadError) return void prepare(); // 오류 뒤에는 모델을 다시 준비한다
  if (again) startRound(false);
  else show('idle');
}

/* ---------- 버튼 ---------- */

onTap('btn-retry', () => void prepare());
onTap('btn-start', () => startRound(true));
onTap('btn-intro-next', () => show('guide'));
onTap('btn-ready', showPrompt);
onTap('btn-draw', startDrawing);
onTap('btn-undo', () => pad.undo(), { once: false });
onTap('btn-clear', () => pad.clear(), { once: false });
onTap('btn-skip', () => question?.skip());
onTap('btn-next', nextQuestion);
onTap('btn-again', () => leaveResult(true));
onTap('btn-end', () => leaveResult(false));

/* ---------- 운영자 진단: Ctrl+Shift+D ---------- */

function renderDiag(): void {
  const d = $('diag');
  const s = stats.data;
  const kw = Object.entries(s.keywords)
    .map(([k, v]) => `${k.padEnd(16)} 출제 ${v.asked}  알아봄 ${v.recognized}  시간종료 ${v.timeout}  건너뜀 ${v.skipped}  빈그림 ${v.empty}  오류 ${v.error}`)
    .join('\n');
  d.textContent = [
    `AI 낙서 탐정 진단   (Ctrl+Shift+D 닫기, Ctrl+Shift+X 통계 초기화)`,
    `앱 ${__APP_VERSION__}  모델 ${bundle?.version ?? '-'}  추론 엔진 ${ortVersion || '-'}  ${lastReady}`,
    `추론 간격 ${client?.intervalMs ?? '-'}ms  부하조절 ${client?.isThrottled ? '켜짐' : '꺼짐'}  최근 20회 P95 ${client?.recentP95.toFixed(1) ?? '-'}ms`,
    `설정 ${JSON.stringify(settings)}`,
    settingsWarnings.length ? `설정 경고:\n  ${settingsWarnings.join('\n  ')}` : '설정 경고 없음',
    '',
    `집계 시작 ${s.since}`,
    `회차 시작 ${s.roundsStarted}  정상 완료 ${s.roundsCompleted}  기술 오류 ${s.roundsErrored}  무조작 복귀 ${s.idleResets}`,
    `평균 체험 시간 ${s.roundMsCount ? (s.roundMsSum / s.roundMsCount / 1000).toFixed(1) : '-'}초`,
    `추론 ${s.inference.count}회  평균 ${s.inference.count ? (s.inference.sumMs / s.inference.count).toFixed(1) : '-'}ms  최대 ${s.inference.maxMs.toFixed(0)}ms  150ms 초과 ${s.inference.over150}회`,
    `모델 준비 실패 ${s.modelLoadFailures}  추론 오류 ${s.inferenceErrors}`,
    s.lastError ? `마지막 오류 ${s.lastError}` : '',
    '',
    kw || '(키워드 기록 없음)',
  ].join('\n');
}

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey)) return;
  if (e.code === 'KeyD') {
    e.preventDefault();
    const d = $('diag');
    d.hidden = !d.hidden;
    if (!d.hidden) renderDiag();
  } else if (e.code === 'KeyX' && !$('diag').hidden) {
    e.preventDefault();
    stats.reset();
    renderDiag();
  }
});

/* ---------- 시작 ---------- */

window.addEventListener('beforeunload', () => stats.flush());
function applyRuleText(): void {
  const sec = String(settings.drawSeconds);
  const hold = settings.successHoldMs / 1000;
  $('rule-count').textContent = String(settings.questionsPerRound);
  $('rule-seconds').textContent = sec;
  $('rule-hold').textContent = Number.isInteger(hold) ? String(hold) : hold.toFixed(1);
  $('prompt-note').innerHTML = `첫 선을 그으면 ${sec}초가 흘러요.<br />어려우면 건너뛰어도 괜찮아요.`;
  $('paper-hint-sub').textContent = `첫 선을 그으면 ${sec}초가 시작돼요`;
}

void loadSettings().then(() => {
  applyRuleText();
  return prepare();
});
