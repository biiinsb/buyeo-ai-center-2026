/**
 * 단일 HTML 체험판용 자원. 모델 묶음과 가중치를 파일 안에 담고,
 * 추론은 페이지 안의 순수 JS 계산으로 한다(네트워크·WASM·Worker 불필요).
 */
import bundleJson from '../public/model/bundle.json';
import type { ModelBundle } from './bundle';
import type { WorkerLike } from './inference/client';
import type { ToWorker } from './inference/protocol';
import { InlineEngine } from './demo/engine';

export async function readSettings(): Promise<{ found: boolean; data?: unknown }> {
  return { found: true, data: undefined };
}

export async function readBundle(): Promise<unknown> {
  return bundleJson;
}

export function createWorker(): WorkerLike {
  return new InlineEngine();
}

export function loadMessage(bundle: ModelBundle): Extract<ToWorker, { type: 'load' }> {
  return { type: 'load', modelUrl: '', sha256: bundle.model.sha256, classes: bundle.model.output.classes, ortBase: '' };
}

export const IS_DEMO = true;
