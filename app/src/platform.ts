/**
 * 실행 환경별 자원 읽기. 키오스크(Electron/웹 서버)는 파일을 fetch 하고
 * onnxruntime-web Worker 를 쓴다. 단일 HTML 체험판은 vite.demo.config.ts 에서
 * 이 모듈을 platform-demo.ts 로 바꿔 끼운다.
 */
import type { ModelBundle } from './bundle';
import type { WorkerLike } from './inference/client';
import type { ToWorker } from './inference/protocol';

/** 운영자 설정 원본. 파일이 없으면 found=false. */
export async function readSettings(): Promise<{ found: boolean; data?: unknown }> {
  const res = await fetch('./settings.json', { cache: 'no-store' });
  return res.ok ? { found: true, data: await res.json() } : { found: false };
}

export async function readBundle(): Promise<unknown> {
  const res = await fetch('./model/bundle.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`bundle.json 을 읽지 못함 (${res.status})`);
  return res.json();
}

export function createWorker(): WorkerLike {
  return new Worker(new URL('./inference/worker.ts', import.meta.url), { type: 'module', name: 'inference' }) as unknown as WorkerLike;
}

export function loadMessage(bundle: ModelBundle): Extract<ToWorker, { type: 'load' }> {
  return {
    type: 'load',
    modelUrl: new URL(`./model/${bundle.model.file}`, document.baseURI).href,
    sha256: bundle.model.sha256,
    classes: bundle.model.output.classes,
    ortBase: new URL('./ort/', document.baseURI).href,
  };
}

export const IS_DEMO = false;
