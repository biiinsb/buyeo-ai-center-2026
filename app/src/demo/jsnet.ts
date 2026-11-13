/**
 * 체험판용 순수 JavaScript 추론. training/train.py 의 DoodleNet 과 같은 계산이다.
 * (BatchNorm 은 export_js_weights.py 에서 합성곱에 합쳤다.)
 * 키오스크 앱은 이 파일이 아니라 onnxruntime-web 을 쓴다.
 */

interface LayerJson {
  out: number;
  in: number;
  w: string;
  b: string;
  poolAfter?: boolean;
}

export interface WeightsJson {
  version: string;
  convs: LayerJson[];
  fc: LayerJson;
}

interface Layer {
  out: number;
  in: number;
  w: Float32Array;
  b: Float32Array;
  poolAfter: boolean;
}

function decode(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** 3x3, padding 1, stride 1 합성곱 + ReLU. 입력/출력은 [C, H, W]. */
function conv3x3Relu(x: Float32Array, size: number, l: Layer): Float32Array {
  const hw = size * size;
  const out = new Float32Array(l.out * hw);
  for (let o = 0; o < l.out; o++) {
    const acc = out.subarray(o * hw, (o + 1) * hw);
    acc.fill(l.b[o]);
    for (let c = 0; c < l.in; c++) {
      const src = x.subarray(c * hw, (c + 1) * hw);
      const k = (o * l.in + c) * 9;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const wv = l.w[k + ky * 3 + kx];
          if (wv === 0) continue;
          const dy = ky - 1;
          const dx = kx - 1;
          const y0 = Math.max(0, -dy);
          const y1 = Math.min(size, size - dy);
          const x0 = Math.max(0, -dx);
          const x1 = Math.min(size, size - dx);
          for (let y = y0; y < y1; y++) {
            const row = y * size;
            const srow = (y + dy) * size + dx;
            for (let xx = x0; xx < x1; xx++) acc[row + xx] += wv * src[srow + xx];
          }
        }
      }
    }
    for (let i = 0; i < hw; i++) if (acc[i] < 0) acc[i] = 0;
  }
  return out;
}

function maxPool2(x: Float32Array, channels: number, size: number): Float32Array {
  const half = size >> 1;
  const out = new Float32Array(channels * half * half);
  for (let c = 0; c < channels; c++) {
    const base = c * size * size;
    for (let y = 0; y < half; y++)
      for (let xx = 0; xx < half; xx++) {
        const i = base + y * 2 * size + xx * 2;
        out[c * half * half + y * half + xx] = Math.max(x[i], x[i + 1], x[i + size], x[i + size + 1]);
      }
  }
  return out;
}

export class JsNet {
  readonly version: string;
  readonly classes: number;
  private readonly convs: Layer[];
  private readonly fc: Layer;

  constructor(json: WeightsJson) {
    this.version = json.version;
    this.convs = json.convs.map((l) => ({ out: l.out, in: l.in, w: decode(l.w), b: decode(l.b), poolAfter: Boolean(l.poolAfter) }));
    this.fc = { out: json.fc.out, in: json.fc.in, w: decode(json.fc.w), b: decode(json.fc.b), poolAfter: false };
    this.classes = this.fc.out;
    for (const l of this.convs) if (l.w.length !== l.out * l.in * 9 || l.b.length !== l.out) throw new Error('가중치 크기 오류');
    if (this.fc.w.length !== this.fc.out * this.fc.in) throw new Error('가중치 크기 오류');
  }

  /** 입력 28x28(0~1, 1=잉크) -> 20종 확률. */
  run(input: Float32Array): Float32Array {
    let x = input;
    let size = 28;
    let channels = 1;
    for (const l of this.convs) {
      x = conv3x3Relu(x, size, l);
      channels = l.out;
      if (l.poolAfter) {
        x = maxPool2(x, channels, size);
        size >>= 1;
      }
    }
    // 전역 평균 풀링
    const hw = size * size;
    const feat = new Float32Array(channels);
    for (let c = 0; c < channels; c++) {
      let s = 0;
      for (let i = 0; i < hw; i++) s += x[c * hw + i];
      feat[c] = s / hw;
    }
    // 선형 + 소프트맥스
    const logits = new Float32Array(this.fc.out);
    let max = -Infinity;
    for (let o = 0; o < this.fc.out; o++) {
      let s = this.fc.b[o];
      for (let i = 0; i < this.fc.in; i++) s += this.fc.w[o * this.fc.in + i] * feat[i];
      logits[o] = s;
      if (s > max) max = s;
    }
    let sum = 0;
    for (let o = 0; o < logits.length; o++) {
      logits[o] = Math.exp(logits[o] - max);
      sum += logits[o];
    }
    for (let o = 0; o < logits.length; o++) logits[o] /= sum;
    return logits;
  }
}
