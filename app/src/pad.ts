/**
 * 터치 도화지. 손가락 하나로만 그리고, 두 번째 손가락과 손바닥 접촉은 무시한다.
 * 선은 추론과 무관하게 즉시 그린다. 좌표는 도화지 CSS 픽셀 기준으로 보관한다.
 */
import { rdp, type Point, type Stroke } from './preprocess';
import type { ChangeKind } from './question';

export const MAX_POINTS = 10000;
const PALM_CONTACT_PX = 70;
const MIN_STEP_PX = 1.5;

/** 문제당 점 수 상한. 넘으면 모양을 유지하며 점점 강하게 단순화한다. */
export function capPoints(strokes: Point[][], max = MAX_POINTS): Point[][] {
  const count = (s: Point[][]) => s.reduce((n, l) => n + l.length, 0);
  if (count(strokes) <= max) return strokes;
  let eps = 0.75;
  let out = strokes;
  while (count(out) > max * 0.8 && eps < 64) {
    out = strokes.map((l) => rdp(l, eps));
    eps *= 1.5;
  }
  return out;
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: readonly Stroke[], width: number, height: number, srcW: number, srcH: number, lineWidth: number, color: string): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const s = Math.min(width / srcW, height / srcH);
  ctx.translate((width - srcW * s) / 2, (height - srcH * s) / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of strokes) {
    if (line.length === 1) {
      ctx.beginPath();
      ctx.arc(line[0][0], line[0][1], lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(line[0][0], line[0][1]);
    for (let i = 1; i < line.length; i++) ctx.lineTo(line[i][0], line[i][1]);
    ctx.stroke();
  }
  ctx.restore();
}

export class DrawingPad {
  onChange: (strokes: Stroke[], kind: ChangeKind) => void = () => {};

  private strokes: Point[][] = [];
  private current: Point[] | null = null;
  private pointerId: number | null = null;
  private locked = true;
  private readonly ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private scale = 1;
  readonly lineWidth = 9;
  readonly color = '#1f2340';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly maxBitmap = 1080) {
    this.ctx = canvas.getContext('2d', { desynchronized: true })!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('lostpointercapture', (e) => this.up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 화면 크기가 바뀌면 내부 비트맵을 맞춘다. 장치 배율만큼 무조건 키우지 않는다(최대 1080). */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // 좌표는 레이아웃 기준(축소 전) 크기로 보관한다.
    this.cssW = this.canvas.offsetWidth;
    this.cssH = this.canvas.offsetHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = Math.min((rect.width * dpr) / this.cssW, this.maxBitmap / this.cssW);
    this.canvas.width = Math.round(this.cssW * this.scale);
    this.canvas.height = Math.round(this.cssH * this.scale);
    this.redraw();
  }

  get isDrawing(): boolean {
    return this.pointerId !== null;
  }

  get size(): [number, number] {
    return [this.cssW, this.cssH];
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.finishStroke(false);
  }

  snapshot(): Stroke[] {
    const all = this.current && this.current.length ? [...this.strokes, this.current] : this.strokes;
    return all.map((s) => s.slice());
  }

  undo(): void {
    if (this.locked || this.isDrawing || !this.strokes.length) return;
    this.strokes.pop();
    this.redraw();
    this.onChange(this.snapshot(), 'undo');
  }

  clear(silent = false): void {
    this.current = null;
    this.pointerId = null;
    const had = this.strokes.length > 0;
    this.strokes = [];
    this.redraw();
    if (!silent && had) this.onChange([], 'clear');
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  private toLocal(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * this.cssW, ((e.clientY - rect.top) / rect.height) * this.cssH];
  }

  private inside([x, y]: Point): boolean {
    return x >= 0 && y >= 0 && x <= this.cssW && y <= this.cssH;
  }

  private isPalm(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && (e.width > PALM_CONTACT_PX || e.height > PALM_CONTACT_PX);
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    if (this.locked || this.pointerId !== null || !e.isPrimary || this.isPalm(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 캡처를 못 해도 도화지 안에서는 그릴 수 있다 */
    }
    this.current = [this.toLocal(e)];
    this.paintDot(this.current[0]);
    this.onChange(this.snapshot(), 'add');
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId || this.locked) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    let changed = false;
    for (const ev of events.length ? events : [e]) {
      const p = this.toLocal(ev);
      if (!this.inside(p)) {
        // 도화지 밖으로 나가면 획을 끊고, 돌아오면 새 획으로 시작한다(경계를 잇는 선 방지).
        if (this.current && this.current.length) {
          this.strokes.push(this.current);
          changed = true;
        }
        this.current = null;
        continue;
      }
      if (!this.current) {
        this.current = [p];
        changed = true;
        continue;
      }
      const last = this.current[this.current.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP_PX) continue;
      this.current.push(p);
      this.paintSegment(last, p);
      changed = true;
    }
    if (changed) {
      this.enforceCap();
      this.onChange(this.snapshot(), 'add');
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.finishStroke(true);
  }

  private finishStroke(notify: boolean): void {
    if (this.pointerId !== null && this.canvas.hasPointerCapture(this.pointerId)) this.canvas.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    if (this.current && this.current.length) this.strokes.push(this.current);
    this.current = null;
    if (notify) this.onChange(this.snapshot(), 'penUp');
  }

  private enforceCap(): void {
    const total = this.strokes.reduce((n, s) => n + s.length, 0) + (this.current?.length ?? 0);
    if (total <= MAX_POINTS) return;
    this.strokes = capPoints(this.strokes);
    if (this.current) this.current = rdp(this.current, 1);
    this.redraw();
  }

  private prep(): CanvasRenderingContext2D {
    const c = this.ctx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.strokeStyle = this.color;
    c.fillStyle = this.color;
    c.lineWidth = this.lineWidth;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    return c;
  }

  private paintDot([x, y]: Point): void {
    const c = this.prep();
    c.beginPath();
    c.arc(x, y, this.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
  }

  private paintSegment(a: Point, b: Point): void {
    const c = this.prep();
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
  }

  private redraw(): void {
    if (!this.cssW) return;
    drawStrokes(this.ctx, this.snapshot(), this.canvas.width, this.canvas.height, this.cssW, this.cssH, this.lineWidth, this.color);
  }
}
