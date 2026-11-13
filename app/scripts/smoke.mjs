// Electron 으로 앱을 띄워 실제 입력으로 한 회차를 진행한다. 결과: smoke-out/
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const electron = createRequire(import.meta.url)('electron');
const out = join(root, 'smoke-out');
// VS Code 터미널 등에서 ELECTRON_RUN_AS_NODE 가 켜져 있으면 Electron 이 Node 로 실행되므로 지운다.
const env = { ...process.env, KIOSK_SMOKE: out };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, ['.'], { cwd: root, stdio: 'inherit', env });
process.exit(r.status ?? 1);
