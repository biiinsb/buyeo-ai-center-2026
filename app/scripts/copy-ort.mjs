// onnxruntime-web 의 WASM 실행 파일을 public/ort/ 로 복사한다.
// 앱은 CDN 기본 경로를 쓰지 않고 이 로컬 파일만 읽는다(PRD: 오프라인 실행).
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
const out = join(root, 'public', 'ort');
mkdirSync(out, { recursive: true });
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  const src = join(dist, name);
  if (!existsSync(src)) throw new Error(`onnxruntime-web 파일 없음: ${src}`);
  copyFileSync(src, join(out, name));
}
const { version } = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'));
console.log(`onnxruntime-web ${version} WASM -> public/ort/`);
