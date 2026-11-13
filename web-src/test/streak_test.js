// 번짐 줄무늬 속도 측정 시험: 실제 연습장 프레임(공 정지) + 롤링 셔터 물리 렌더링(시간 표본 64개, 모델과 다른 방식)
// 공 무늬는 실제 공 사진에서 가져옴, 잡음·클럽(어두운 막대) 포함
const S = require('../src/streak.js'); const fs = require('fs');
const W = 640, H = 360;
const ref = new Uint8Array(fs.readFileSync('../real/range.raw'));
const bg = new Uint8Array(fs.readFileSync('../real/range_noball.raw'));
const rest = { cx: 125, cy: 288, r: 28 };
const R = 0.021335, pxm = rest.r / R; // 공 깊이에서 1m = pxm 화소
let ballLum = 0, bn = 0; for (let y = -20; y <= 20; y++) for (let x = -20; x <= 20; x++) if (x * x + y * y < 400) { ballLum += ref[(rest.cy + y) * W + rest.cx + x]; bn++; } ballLum /= bn;
let rng = 3; const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };

function render({ v, vla, texp, trow, tau0, club = true, noise = 3 }) {
  const a = vla * Math.PI / 180, vx = v * Math.cos(a) * pxm, vy = -v * Math.sin(a) * pxm; // 화면 아래 = +y
  const g = new Float32Array(W * H);
  const NS = 64;
  for (let y = 0; y < H; y++) {
    const b = tau0 + y * trow, a0 = b - texp;
    for (let x = 0; x < W; x++) {
      const i = y * W + x; let acc = 0;
      for (let s = 0; s < NS; s++) {
        const t = a0 + (s + 0.5) / NS * texp;
        const tt = Math.max(0, t), cx = rest.cx + vx * tt, cy = rest.cy + vy * tt;
        const dx = x - cx, dy = y - cy;
        let val;
        if (dx * dx + dy * dy <= rest.r * rest.r) { // 공 무늬(정지 공 사진에서, 회전은 무시)
          val = ref[Math.round(rest.cy + dy) * W + Math.round(rest.cx + dx)];
        } else val = bg[i];
        // 클럽 헤드: 임팩트 때 공 뒤에서 앞으로 지나가는 어두운 사각형(40 m/s)
        if (club) { const hx = rest.cx - 40 + 40 * pxm * t, hy = rest.cy; if (x > hx - 35 && x < hx && Math.abs(y - hy + 5) < 22) val = 40; }
        acc += val;
      }
      g[i] = acc / NS + gauss() * noise;
    }
  }
  return Uint8Array.from(g, v => Math.max(0, Math.min(255, Math.round(v))));
}
if (require.main === module) {
  const cases = [];
  for (const [v, vla] of [[70, 12], [65, 15], [50, 20], [40, 30], [30, 50], [25, 75]])
    for (const texp of [1 / 1000, 1 / 2000]) for (const trow of [0, 20e-6]) for (let rep = 0; rep < (+process.env.REP || 1); rep++) cases.push({ v, vla, texp, trow });
  let ok = 0, n = 0, good7 = 0, wrong = 0, none = 0; const ev = [], ea = [];
  for (const c of cases) {
    // 줄무늬가 화면 안에 들어오는 임의 시점(첫 프레임)
    const span = (W - rest.cx - 2 * rest.r) / (c.v * pxm * Math.cos(c.vla * Math.PI / 180)) - c.texp;
    const span2 = (rest.cy - 2 * rest.r) / (c.v * pxm * Math.sin(c.vla * Math.PI / 180)) - c.texp;
    const tmax = Math.max(0.0003, Math.min(span, span2) - H * c.trow * 0.5);
    const tau0 = c.texp * 0.5 + rnd() * tmax;
    const g = render({ ...c, tau0 });
    const t0 = Date.now();
    const a_ = c.vla * Math.PI / 180;
    const m = S.measure({ gray: g, w: W, h: H }, ref, rest, { texp: c.texp, fps: 120, ballLum, dir: 1, truth: [tau0, c.v * Math.cos(a_) * pxm, -c.v * Math.sin(a_) * pxm, c.trow] });
    const ms = Date.now() - t0;
    n++;
    if (process.env.SAVE && (!m || !m.ok || Math.abs(Math.hypot(m.vx, m.vy) / pxm - c.v) / c.v > 0.05)) require('fs').writeFileSync(`/tmp/sf_${c.v}_${c.vla}_${Math.round(1 / c.texp)}_${Math.round(c.trow * 1e6)}.pgm`, Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), Buffer.from(g)]));
    if (!m || !m.ok) { none++; console.log(`tau0 ${(tau0 * 1e3).toFixed(2)}ms `, `${c.v}m/s ${c.vla}° 1/${(1 / c.texp).toFixed(0)} 행${(c.trow * 1e6).toFixed(0)}µs  ✗ ${m ? m.why + ' nres ' + (m.nres || 0).toFixed(2) : ''}`); continue; }
    const v = Math.hypot(m.vx, m.vy) / pxm, vla = Math.atan2(-m.vy, m.vx) * 180 / Math.PI;
    const e1 = (v - c.v) / c.v * 100, e2 = vla - c.vla; ev.push(Math.abs(e1)); ea.push(Math.abs(e2));
    const good = Math.abs(e1) < 5 && Math.abs(e2) < 3; if (good) ok++;
    if (Math.abs(e1) < 7 && Math.abs(e2) < 3) good7++; else wrong++;
    console.log(`${c.v}m/s ${c.vla}° 1/${(1 / c.texp).toFixed(0)} 행${(c.trow * 1e6).toFixed(0)}µs → ${v.toFixed(1)}m/s (${e1 >= 0 ? '+' : ''}${e1.toFixed(1)}%) ${vla.toFixed(1)}° (${e2 >= 0 ? '+' : ''}${e2.toFixed(1)}°) 행읽기 ${(m.tRow * 1e6).toFixed(1)}µs 잔차 ${m.nres.toFixed(2)} 참값오차/찾은오차 ${(m.truthLoss / m.fitLoss).toFixed(2)} ${ms}ms ${good ? '✓' : '✗'}`);
  }
  ev.sort((a, b) => a - b); ea.sort((a, b) => a - b);
  console.log(`정답(속도±7%·각도±3°) ${good7}/${n} · 틀린 값 ${wrong}/${n} · 측정 못 함 ${none}/${n}`);
  console.log(`통과 ${ok}/${n} · 속도 오차 중앙값 ${ev[ev.length >> 1]?.toFixed(1)}% · 발사각 오차 중앙값 ${ea[ea.length >> 1]?.toFixed(1)}°`);
}
module.exports = { render, rest, ref, ballLum, pxm };
