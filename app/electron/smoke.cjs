/**
 * 개발용 종단 점검. KIOSK_SMOKE=출력폴더 로 실행하면 main.cjs 가 불러온다.
 * 실제 마우스 입력(sendInputEvent)으로 제시어에 해당하는 Quick Draw 시험 세트 그림을 따라 그리고,
 * 화면별 캡처와 문제별 결과를 출력 폴더에 남긴다. training/data/raw 가 있어야 한다.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const RAW = path.join(__dirname, '..', '..', 'training', 'data', 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testDrawing(classId, skip = 0) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW, `${classId}.ndjson`)) });
  let seen = 0;
  for await (const line of rl) {
    const row = JSON.parse(line);
    const h = BigInt('0x' + crypto.createHash('sha1').update(row.key_id).digest('hex')) % 20n;
    if (h === 0n && row.recognized && seen++ >= skip) {
      rl.close();
      return row.drawing; // [[xs], [ys]] 0~255
    }
  }
  throw new Error(`no test drawing for ${classId}`);
}

module.exports = async function smoke(win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);
  const screen = () => js('document.body.dataset.screen');
  const shot = async (name) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await wc.capturePage()).toPNG());
  const waitFor = async (name, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if ((await screen()) === name) return;
      await sleep(100);
    }
    throw new Error(`screen ${name} not reached (now ${await screen()})`);
  };
  const tap = async (id) => {
    const r = await js(`(() => { const b = document.getElementById('${id}').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    const [x, y] = r.map(Math.round);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const draw = async (drawing, afterFirst) => {
    const rect = await js(`(() => { const b = document.getElementById('pad').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()`);
    const [rx, ry, rw, rh] = rect;
    const s = (Math.min(rw, rh) * 0.7) / 255;
    const ox = rx + rw * 0.15;
    const oy = ry + rh * 0.15;
    for (const [xs, ys] of drawing) {
      const pts = xs.map((x, i) => [Math.round(ox + x * s), Math.round(oy + ys[i] * s)]);
      wc.sendInputEvent({ type: 'mouseDown', x: pts[0][0], y: pts[0][1], button: 'left', clickCount: 1 });
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
        for (let k = 1; k <= steps; k++) {
          wc.sendInputEvent({ type: 'mouseMove', x: Math.round(ax + ((bx - ax) * k) / steps), y: Math.round(ay + ((by - ay) * k) / steps), button: 'left', modifiers: ['leftButtonDown'] });
          await sleep(8);
        }
      }
      const last = pts[pts.length - 1];
      wc.sendInputEvent({ type: 'mouseUp', x: last[0], y: last[1], button: 'left', clickCount: 1 });
      await sleep(120);
      if (afterFirst) {
        await sleep(400);
        await afterFirst();
        afterFirst = null;
      }
      if ((await screen()) !== 'draw') return;
    }
  };

  const report = { questions: [], startedAt: new Date().toISOString() };
  try {
    await waitFor('idle', 30000);
    await shot('01-idle');
    await tap('btn-start');
    await waitFor('guide');
    await shot('02-guide');
    await tap('btn-ready');
    for (let q = 0; q < 5; q++) {
      await waitFor('prompt');
      if (q === 0) await shot('03-prompt');
      const word = await js(`document.getElementById('prompt-word').textContent`);
      const bundle = await js(`fetch('./model/bundle.json').then(r => r.json())`);
      const label = bundle.labels.find((l) => l.word === word);
      await tap('btn-draw');
      await waitFor('draw');
      const t0 = Date.now();
      if (q === 4) {
        await tap('btn-skip'); // 건너뛰기 경로
      } else {
        await draw(await testDrawing(label.id, q), q === 0 ? () => shot('04-draw') : null);
      }
      await waitFor('feedback', 40000);
      const status = await js(`document.getElementById('fb-status').textContent + ' | ' + document.getElementById('fb-guess').textContent`);
      report.questions.push({ word, id: label.id, status, ms: Date.now() - t0 });
      if (q === 0) await shot('05-feedback');
      await tap('btn-next');
    }
    await waitFor('result');
    await sleep(500);
    await shot('06-result');
    report.diag = await js(`(() => { const e = new KeyboardEvent('keydown', { code: 'KeyD', ctrlKey: true, shiftKey: true }); document.dispatchEvent(e); return document.getElementById('diag').textContent; })()`);
    await shot('07-diag');
    const mem = await require('electron').app.getAppMetrics();
    report.memoryMB = mem.reduce((s, m) => s + m.memory.workingSetSize / 1024, 0).toFixed(1);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.stack || error);
    await shot('99-error').catch(() => {});
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report.ok;
};
