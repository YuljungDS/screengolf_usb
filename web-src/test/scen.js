// 시나리오: ① 공 2개(오토티+매트) → 매트 공 ② 연습 스윙·명암 변화 → 고정 유지 ③ 티 공 고정 후 매트에 공 → 매트 공으로 변경 ④ 공 치움 → 다시 찾기
const D = require('../src/detector.js'); const fs = require('fs');
const L = n => new Uint8Array(fs.readFileSync(n + '.raw'));
const W = 640, H = 360;
let t = 0; const dt = 1 / 120;
function run(det, frames, label) {
  const states = new Set(); let shots = 0, o;
  for (const g of frames) { o = det.process({ gray: g, w: W, h: H, t }); t += dt; states.add(o.state); if (o.shot) shots++; }
  const r = det.rest;
  console.log(label.padEnd(34), '상태', o.state.padEnd(6), '거친 상태', [...states].join('>'), '| 샷', shots, '| 공', r ? `${r.cx.toFixed(0)},${r.cy.toFixed(0)} r${r.r.toFixed(0)} ${r.onTee ? '티' : '지면'}` : '-', '|', o.msg.slice(0, 40));
  return o;
}
const rep = (g, n) => Array(n).fill(g);
const gain = (g, a) => g.map(v => Math.min(255, Math.round(v * a)));
function club(g, x0) { const o = new Uint8Array(g); for (let y = 120; y < 330; y++) for (let x = x0; x < x0 + 40; x++) if (x >= 0 && x < W) o[y * W + x] = 35; return o; }
const box = L('box_clean'), both = L('both'), teeonly = L('teeonly'), noball = L('noball');
let ok = true; const chk = (c, m) => { if (!c) { ok = false; console.log('  ✗', m); } else console.log('  ✓', m); };

let det = new D.ShotDetector({ camDist: 0.4 });
let o = run(det, rep(both, 40), '① 오토티 공 + 매트 공');
chk(o.state === 'ready' && Math.abs(det.rest.cx - 431) < 6 && !det.rest.onTee, '매트(지면) 공 고정');

o = run(det, [...rep(gain(both, 0.72), 30), ...rep(gain(both, 1.2), 30)], '② 명암 변화(구름·해)');
chk(o.state === 'ready' && Math.abs(det.rest.cx - 431) < 6, '같은 공 유지');
const sweep = []; for (let k = 0; k < 8; k++) sweep.push(club(both, 300 + k * 30));
o = run(det, [...sweep, ...rep(both, 50)], '② 연습 스윙(클럽이 공 위 통과)');
chk(o.state === 'ready' && Math.abs(det.rest.cx - 431) < 6, '같은 공 유지, 샷 없음');
const hold = []; for (let k = 0; k < 60; k++) hold.push(club(both, 400)); // 클럽을 공 위에 1/2초 대고 있음(어드레스)
o = run(det, [...hold, ...rep(both, 30)], '② 클럽을 공 앞에 대고 있다 뗌');
chk(o.state === 'ready' && Math.abs(det.rest.cx - 431) < 6, '같은 공 유지');

det = new D.ShotDetector({ camDist: 0.4 });
o = run(det, rep(teeonly, 40), '③ 오토티 공만');
chk(o.state === 'ready' && det.rest.onTee, '티 위 공 고정(티 판별)');
o = run(det, rep(both, 60), '③ 매트에 공을 놓음');
chk(o.state === 'ready' && Math.abs(det.rest.cx - 431) < 6 && !det.rest.onTee, '매트 공으로 변경');

o = run(det, rep(noball, 420), '④ 매트 공을 치움(궤적 없음)');
chk(o.state !== 'ready' || Math.abs(det.rest.cx - 431) > 20, '고정 해제 → 다시 찾기');
console.log(ok ? '모두 통과' : '실패 있음');
