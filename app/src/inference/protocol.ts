import type { Stroke } from '../preprocess';

export type ToWorker =
  | { type: 'load'; modelUrl: string; sha256: string; classes: number; ortBase: string }
  | { type: 'infer'; id: number; strokes: Stroke[] };

export type FromWorker =
  | { type: 'ready'; loadMs: number; warmupMs: number; ortVersion: string }
  | { type: 'result'; id: number; probs: Float32Array; computeMs: number }
  | { type: 'error'; id?: number; message: string };
