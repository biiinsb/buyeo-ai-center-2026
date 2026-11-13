import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * onnxruntime-web 이 import.meta.url 로 참조하는 WASM 사본을 빌드에서 뺀다.
 * 앱은 worker 에서 wasmPaths 로 지정한 ort/ 폴더의 파일만 읽는다(scripts/copy-ort.mjs).
 */
function dropBundledOrtWasm(): Plugin {
  return {
    name: 'drop-bundled-ort-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [dropBundledOrtWasm()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  worker: { format: 'es', plugins: () => [dropBundledOrtWasm()] },
  server: { port: 5173, strictPort: true },
});
