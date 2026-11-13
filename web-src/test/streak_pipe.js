// 전체 흐름: 120fps, 공 고정 → 임팩트 → (공은 0~1프레임만 화면에) → 번짐 줄무늬로 샷 계산
const D = require('../src/detector.js'); const T = require('./streak_test.js');
const W = 640, H = 360, { rest, ref, pxm, render } = T;
let rng = 11; const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const fps = 120;
const fs = require('fs');
const STILL = ref, GONE = new Uint8Array(fs.readFileSync('../real/range_noball.raw'));
const noisy = g => Uint8Array.from(g, x => Math.max(0, Math.min(255, x + Math.round((rnd() - 0.5) * 6))));
let ok = 0, n = 0, wrong = 0, none = 0, vis = 0, okVis = 0;
for (const [v, vla] of [[70, 12], [65, 15], [50, 20], [40, 30], [30, 50], [25, 75]])
  for (const [texp, trow] of [[1 / 1000, 20e-6], [1 / 2000, 20e-6], [1 / 1000, 0]])
    for (let rep = 0; rep < 2; rep++) {
      const det = new D.ShotDetector({ camDist: 0.4, expTime: texp, dir: process.env.DIR || 'right' });
      const tImp = 0.2 + rnd() / fps; // 임팩트 시각(프레임 사이 임의)
      let shot = null, k = 0, nIn = 0;
      for (; k < 160 && !shot; k++) {
        const tf = k / fps; // 프레임 k: 0행 노출 끝 시각
        const tau0 = tf - tImp;
        const g = tau0 <= -texp ? noisy(STILL) : tau0 > 0.03 ? noisy(GONE) : render({ v, vla, texp, trow, tau0, club: true });
        if (tau0 > 0) { const a_ = vla * Math.PI / 180, tm = Math.max(0, tau0 - texp / 2), x = rest.cx + v * Math.cos(a_) * pxm * tm, y = rest.cy - v * Math.sin(a_) * pxm * tm; if (x < W - rest.r && y > rest.r && Math.hypot(x - rest.cx, y - rest.cy) > rest.r * 1.5) nIn++; }
        const o = det.process({ gray: g, w: W, h: H, t: tf });
        if (o.shot) shot = o.shot;
      }
      n++; if (nIn) vis++;
      const tag = `[화면에 ${nIn}프레임] ${v}m/s ${vla}° 1/${Math.round(1 / texp)} 행${trow * 1e6}µs`;
      if (!shot || !shot.ok) { none++; console.log(tag, '→ 샷 없음', det.msg, det.lastStreak ? `(줄무늬: ${det.lastStreak.why || ''} nres ${(det.lastStreak.nres || 0).toFixed(2)})` : ''); continue; }
      const e1 = (shot.speed - v) / v * 100, e2 = shot.vla - vla;
      const good = Math.abs(e1) < 7 && Math.abs(e2) < 3; if (good) { ok++; if (nIn) okVis++; } else wrong++;
      console.log(tag, `→ ${shot.speed.toFixed(1)}m/s (${e1.toFixed(1)}%) ${shot.vla.toFixed(1)}° hla ${shot.hla.toFixed(1)} [${shot.speedFrom || '추적'} ${shot.frames}프레임]`, good ? '✓' : '✗');
    }
console.log(`정답 ${ok}/${n} · 틀린 값 ${wrong} · 샷 없음 ${none} · 공이 화면에 찍힌 경우 ${vis}건 중 정답 ${okVis}`);
