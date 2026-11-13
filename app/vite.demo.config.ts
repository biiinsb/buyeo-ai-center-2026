/**
 * 단일 HTML 체험판 빌드: npm run demo -> dist-demo/ai-doodle-detective-demo.html
 * - './platform' 을 platform-demo.ts 로 바꾼다(모델 내장, 순수 JS 추론 Worker 인라인).
 * - JS, CSS, Worker 를 HTML 한 파일에 넣는다. 더블클릭해서 브라우저로 열면 동작한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const demoPlatform = fileURLToPath(new URL('./src/platform-demo.ts', import.meta.url));

function swapPlatform(): Plugin {
  return {
    name: 'swap-platform',
    enforce: 'pre',
    resolveId(source, importer) {
      const from = (importer ?? '').split('\\').join('/');
      if (source === './platform' && from.endsWith('/src/main.ts')) return demoPlatform;
      return null;
    },
  };
}

const DEMO_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob: data:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** 문자열 그대로 찾기 위해 정규식 특수문자를 이스케이프한다. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);

function inlineAll(): Plugin {
  return {
    name: 'inline-all',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') throw new Error('index.html 없음');
      let text = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk') {
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          const tag = new RegExp(`<script[^>]*src="\\./${literal(name)}"[^>]*></script>`);
          if (!tag.test(text)) throw new Error(`script 태그를 찾지 못함: ${name}`);
          text = text.replace(tag, () => `<script type="module">${code}</script>`);
          delete bundle[name];
        } else if (file.fileName.endsWith('.css')) {
          const tag = new RegExp(`<link[^>]*href="\\./${literal(name)}"[^>]*>`);
          if (!tag.test(text)) throw new Error(`link 태그를 찾지 못함: ${name}`);
          text = text.replace(tag, () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      text = text.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*" ?\/?>/, `<meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}" />`);
      text = text.replace(/<link rel="icon"[^>]*>/, '');
      text = text.replace('<title>AI 낙서 탐정</title>', '<title>AI 낙서 탐정 (체험판)</title>');
      if (/(src|href)="\.\/assets/.test(text)) throw new Error('인라인되지 않은 자원이 남아 있음');
      html.source = text;
      html.fileName = 'ai-doodle-detective-demo.html';
    },
  };
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(`${pkg.version}-demo`) },
  publicDir: false,
  plugins: [swapPlatform(), inlineAll()],
  build: {
    target: 'es2022',
    outDir: 'dist-demo',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  worker: { format: 'es' },
});
