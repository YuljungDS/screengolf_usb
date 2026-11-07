// 딤플 무늬 골프공 합성 영상 → 검출기 → 스핀(특히 사이드스핀 부호·크기) 검증
const { ShotDetector } = require('../detector.js');
const RPM = 2 * Math.PI / 60;

// 공 표면 무늬: 피보나치 구면 배치 딤플 332개(약간 흔들어 비주기화) + 선택적 마커 띠 + 작은 로고
function makeBall(seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const N = 332, D = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) * 2 / N, rr = Math.sqrt(1 - y * y), th = ga * i;
    let p = [Math.cos(th) * rr + (rnd() - .5) * .03, y + (rnd() - .5) * .03, Math.sin(th) * rr + (rnd() - .5) * .03];
    const l = Math.hypot(...p); D.push(p.map(v => v / l));
  }
  return { D, rad: 0.085 };
}
function rotExp(w, t) {
  const th = Math.hypot(...w) * t;
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const k = w.map(x => x / Math.hypot(...w)), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = k;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
// 딤플 근방 탐색 가속: 방향 → 가까운 딤플 후보 격자
function dimpleShade(ball, nb, grid) {
  const key = (Math.floor((nb[0] + 1) * 8)) * 289 + (Math.floor((nb[1] + 1) * 8)) * 17 + Math.floor((nb[2] + 1) * 8);
  const list = grid.get(key) || [];
  let v = 0;
  for (const d of list) {
    const c = nb[0] * d[0] + nb[1] * d[1] + nb[2] * d[2];
    const ang = Math.acos(Math.min(1, c));
    if (ang < ball.rad) { const u = ang / ball.rad; v = Math.max(v, 1 - u * u); }
  }
  return v;
}
function buildGrid(ball) {
  const g = new Map();
  for (const d of ball.D) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const k = (Math.floor((d[0] + 1) * 8) + dx) * 289 + (Math.floor((d[1] + 1) * 8) + dy) * 17 + Math.floor((d[2] + 1) * 8) + dz;
    if (!g.has(k)) g.set(k, []); g.get(k).push(d);
  }
  return g;
}

function run({ label, fps, speed, vla, hla, spin, tex = 'dimple', W = 640, H = 400, fpx = 700, camDist = 0.5, noise = 5, dir = 1, blurExp = 0 }) {
  const ball = makeBall(), grid = buildGrid(ball);
  const R = 0.04267 / 2;
  const M = dir > 0 ? [[0, 0, -1], [1, 0, 0], [0, -1, 0]] : [[0, 0, 1], [-1, 0, 0], [0, -1, 0]];
  const MT = M[0].map((_, i) => M.map(r => r[i]));
  const ap = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const a = vla * Math.PI / 180, b = hla * Math.PI / 180;
  const vw = [speed * Math.cos(a) * Math.sin(b), speed * Math.cos(a) * Math.cos(b), speed * Math.sin(a)];
  const vc = ap(MT, vw), wc = ap(MT, spin.map(x => x * RPM));
  const P0 = [-0.12 * dir, 0.04, camDist];
  const markN = [0.3, 0.8, 0.52].map(v => v / Math.hypot(0.3, 0.8, 0.52));
  const L0 = process.env.LIGHT ? JSON.parse(process.env.LIGHT) : [-0.4, -0.6, -0.7]; const light = L0.map(v => v / Math.hypot(...L0)); // 기본: 카메라 쪽 위 왼편 조명
  const det = new ShotDetector({ camDist: Math.hypot(...P0), dir: 'auto', spinMode: process.env.MODE || 'auto' }); // 사용자가 재는 값 = 카메라↔공 직선거리
  const tImp = 20.4 / fps;
  let res = null, rng = 99; const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const t0 = Date.now();
  for (let fi = 0; fi < 400 && !res; fi++) {
    const t = fi / fps, gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) gray[i] = 45 + (rnd() - .5) * noise;
    const dt = Math.max(0, t - tImp);
    const Pc = [P0[0] + vc[0] * dt, P0[1] + vc[1] * dt, P0[2] + vc[2] * dt];
    const Rt = rotExp(wc, dt);
    const u0 = W / 2 + fpx * Pc[0] / Pc[2], v0 = H / 2 + fpx * Pc[1] / Pc[2], rr = fpx * R / Pc[2];
    const off = u0 - rr > W + 5;
    if (!off) for (let y = Math.floor(v0 - rr) - 1; y <= v0 + rr + 1; y++) for (let x = Math.floor(u0 - rr) - 1; x <= u0 + rr + 1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      let acc = 0, cov = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) { // 2x2 슈퍼샘플링
        // 정확한 원근: 픽셀 광선과 구의 교점에서 법선
        let rx = (x + 0.25 + sx * 0.5 - W / 2) / fpx, ry = (y + 0.25 + sy * 0.5 - H / 2) / fpx, rz = 1;
        const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
        const bq = rx * Pc[0] + ry * Pc[1] + rz * Pc[2], cq = Pc[0] ** 2 + Pc[1] ** 2 + Pc[2] ** 2 - R * R, disc = bq * bq - cq;
        if (disc < 0) continue;
        const tt = bq - Math.sqrt(disc);
        const n = [(rx * tt - Pc[0]) / R, (ry * tt - Pc[1]) / R, (rz * tt - Pc[2]) / R];
        const nb = [Rt[0][0] * n[0] + Rt[1][0] * n[1] + Rt[2][0] * n[2], Rt[0][1] * n[0] + Rt[1][1] * n[1] + Rt[2][1] * n[2], Rt[0][2] * n[0] + Rt[1][2] * n[1] + Rt[2][2] * n[2]];
        const lam = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
        let I = 70 + 160 * lam;
        if (tex === 'dimple' || tex === 'both') I -= 55 * dimpleShade(ball, nb, grid);
        if ((tex === 'marker' || tex === 'both') && Math.abs(nb[0] * markN[0] + nb[1] * markN[1] + nb[2] * markN[2]) < 0.12) I = 35;
        acc += I; cov++;
      }
      if (cov) gray[y * W + x] = Math.max(0, Math.min(255, (acc / cov) * (cov / 4) + gray[y * W + x] * (1 - cov / 4) + (rnd() - .5) * noise));
    }
    if (process.env.DUMP2) require('fs').appendFileSync(process.env.DUMP2, Buffer.from(gray));
    const out = det.process({ gray, w: W, h: H, t });
    if (out.shot) res = out.shot;
  }
  const f = x => x == null ? '-' : x.toFixed(0);
  if (!res) { console.log(label, 'NO SHOT', det.msg); return null; }
  const side = res.spin ? -res.spin[2] : null, trueSide = -spin[2];
  const ok = res.spin && Math.sign(side) === Math.sign(trueSide || 0.0001) ;
  console.log(`${label.padEnd(26)} hla ${res.hla.toFixed(1)}/${hla} r=${(fpx * R / camDist).toFixed(0)}px fr=${res.frames} ${res.spinFrom}(${(res.spinConf || 0).toFixed(2)}) | back ${f(res.spin?.[0])}/${spin[0]}  side ${f(side)}/${trueSide}  rifle ${f(res.spin?.[1])}/${spin[1]} | v ${res.speed.toFixed(1)}/${speed} ${Date.now() - t0}ms ${trueSide ? (ok ? '✓방향' : '✗방향') : ''}`);
  return res;
}
module.exports = { run };
if (require.main === module) {
  const C = process.argv[2] || 'all';
  if (C === 'quick') {
    run({ label: '1000fps 7i slice', fps: 1000, speed: 45, vla: 17, hla: 1, spin: [6000, 0, -900] });
  } else {
    run({ label: '1000fps 7i slice(+900)', fps: 1000, speed: 45, vla: 17, hla: 1, spin: [6000, 0, -900] });
    run({ label: '1000fps 7i hook(-900)', fps: 1000, speed: 45, vla: 17, hla: -1, spin: [6000, 0, 900] });
    run({ label: '1000fps drv fade(+400)', fps: 1000, speed: 60, vla: 12, hla: 0, spin: [2600, 0, -400] });
    run({ label: '1000fps drv draw(-400)', fps: 1000, speed: 60, vla: 12, hla: 0, spin: [2600, 0, 400] });
    run({ label: '500fps drv slice(+1000)', fps: 500, speed: 55, vla: 12, hla: 2, spin: [2800, 0, -1000] });
    run({ label: '500fps drv hook(-800)', fps: 500, speed: 55, vla: 12, hla: -2, spin: [2400, 0, 800] });
    run({ label: '240fps chip(+300)', fps: 240, speed: 15, vla: 25, hla: 0, spin: [2500, 0, -300] });
    run({ label: '240fps 7i slice (too fast)', fps: 240, speed: 45, vla: 17, hla: 1, spin: [6000, 0, -900] });
  }
}
