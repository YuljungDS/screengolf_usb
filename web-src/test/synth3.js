// 실외형 합성 장면: 임의 카메라 자세(측면/비스듬/후방) + 잔디 지면 + 하늘 + 티(선택)
// 검증: 티 판별, 두 공 자세 보정, 비스듬·후방 촬영에서 속도·방향·스핀
const D = require('../detector.js');
const RPM = 2 * Math.PI / 60;
const R = 0.04267 / 2;

function makeBall(seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const N = 332, P = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) * 2 / N, rr = Math.sqrt(1 - y * y), th = ga * i;
    const p = [Math.cos(th) * rr + (rnd() - .5) * .03, y + (rnd() - .5) * .03, Math.sin(th) * rr + (rnd() - .5) * .03];
    const l = Math.hypot(...p); P.push(p.map(v => v / l));
  }
  const g = new Map(), key = d => (Math.floor((d[0] + 1) * 8)) * 289 + (Math.floor((d[1] + 1) * 8)) * 17 + Math.floor((d[2] + 1) * 8);
  for (const d of P) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const k = (Math.floor((d[0] + 1) * 8) + a) * 289 + (Math.floor((d[1] + 1) * 8) + b) * 17 + Math.floor((d[2] + 1) * 8) + c;
    if (!g.has(k)) g.set(k, []); g.get(k).push(d);
  }
  return n => { let v = 0; for (const d of g.get(key(n)) || []) { const ang = Math.acos(Math.min(1, n[0] * d[0] + n[1] * d[1] + n[2] * d[2])); if (ang < 0.085) { const u = ang / 0.085; v = Math.max(v, 1 - u * u); } } return v; };
}
function rotExp(w, t) {
  const th = Math.hypot(...w) * t;
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map(v => v / Math.hypot(...w)), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
const mul = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const T = A => A[0].map((_, i) => A.map(r => r[i]));

// pose: {phi, pitch, roll}, rho: 카메라↔공 거리, shift: 카메라 좌표에서 공을 화면 어디에 둘지 [x,y] (m)
function scene({ pose, rho = 0.5, shift = [0.12, 0], tee = false, teeH = 0.025, W = 640, H = 400, fpx = 700 }) {
  const M = D.camPose(pose.phi, pose.pitch || 0, pose.roll || 0); // world ← cam (열=카메라축)
  const MT = T(M);
  const ballW = [0, 0, (tee ? teeH : 0) + R];
  const zc = [M[0][2], M[1][2], M[2][2]], xc = [M[0][0], M[1][0], M[2][0]], yc = [M[0][1], M[1][1], M[2][1]];
  const C = [0, 1, 2].map(i => ballW[i] - zc[i] * rho + xc[i] * shift[0] + yc[i] * shift[1]);
  const toCam = p => mul(MT, [p[0] - C[0], p[1] - C[1], p[2] - C[2]]);
  // 정적 배경: 지면(z=0) 잔디, 그 위는 하늘·구름
  const bg = new Uint8Array(W * H);
  let s = 3; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rc = [(x + .5 - W / 2) / fpx, (y + .5 - H / 2) / fpx, 1];
    const rw = mul(M, rc);
    let v;
    if (rw[2] < -1e-6) {
      const t = -C[2] / rw[2], gx = C[0] + rw[0] * t, gy = C[1] + rw[1] * t;
      v = 70 + 18 * Math.sin(gx * 900) * Math.sin(gy * 700) + (rnd() - .5) * 26; // 잔디
    } else {
      v = 120 + 30 * rw[2] + (Math.sin(x * 0.02) * Math.sin(y * 0.05) > 0.8 ? 60 : 0); // 하늘 + 구름 띠
    }
    bg[y * W + x] = Math.max(0, Math.min(255, v));
  }
  if (tee) { // 티: 지면~공 아래까지 흰 기둥 (반지름 3mm)
    for (let z = 0; z <= teeH; z += 0.0005) {
      const pc = toCam([0, 0, z]); if (pc[2] <= 0) continue;
      const u = W / 2 + fpx * pc[0] / pc[2], v = H / 2 + fpx * pc[1] / pc[2], hw = 0.003 * fpx / pc[2];
      for (let x = Math.floor(u - hw); x <= u + hw; x++) if (x >= 0 && x < W && v >= 0 && v < H) bg[Math.floor(v) * W + x] = 215;
    }
  }
  return { M, MT, C, ballW, toCam, bg, W, H, fpx, rho };
}

function shoot(sc, { fps, speed, vla, hla, spin, frames = 400, opts = {} }) {
  const tex = makeBall();
  const a = vla * Math.PI / 180, b = hla * Math.PI / 180;
  const vw = [speed * Math.cos(a) * Math.sin(b), speed * Math.cos(a) * Math.cos(b), speed * Math.sin(a)];
  const wc = mul(sc.MT, spin.map(x => x * RPM));
  const light = mul(sc.MT, [-0.3, -0.5, 0.8]).map((v, i, A) => v / Math.hypot(...A)); // 해: 위·뒤쪽 (월드 기준)
  const det = new D.ShotDetector(Object.assign({ camDist: Math.hypot(sc.C[0] - sc.ballW[0], sc.C[1] - sc.ballW[1], sc.C[2] - sc.ballW[2]), dir: 'auto' }, opts)); // 사용자가 줄자로 잰 직선거리
  const tImp = 60.4 / fps; // 공이 놓인 뒤 60프레임 후 임팩트
  let res = null, rng = 9; const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const { W, H, fpx } = sc;
  let lockedTee = null;
  for (let fi = 0; fi < frames && !res; fi++) {
    const t = fi / fps, gray = new Uint8Array(sc.bg);
    const dt = Math.max(0, t - tImp);
    const pw = [sc.ballW[0] + vw[0] * dt, sc.ballW[1] + vw[1] * dt, sc.ballW[2] + vw[2] * dt];
    const Pc = sc.toCam(pw), Rt = rotExp(wc, dt);
    if (Pc[2] > 0.05) {
      const u0 = W / 2 + fpx * Pc[0] / Pc[2], v0 = H / 2 + fpx * Pc[1] / Pc[2], rr = fpx * R / Pc[2] * 1.3;
      for (let y = Math.floor(v0 - rr) - 1; y <= v0 + rr + 1; y++) for (let x = Math.floor(u0 - rr) - 1; x <= u0 + rr + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        let acc = 0, cov = 0;
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          let rx = (x + .25 + sx * .5 - W / 2) / fpx, ry = (y + .25 + sy * .5 - H / 2) / fpx, rz = 1;
          const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
          const bq = rx * Pc[0] + ry * Pc[1] + rz * Pc[2], cq = Pc[0] ** 2 + Pc[1] ** 2 + Pc[2] ** 2 - R * R, disc = bq * bq - cq;
          if (disc < 0) continue;
          const tt = bq - Math.sqrt(disc), n = [(rx * tt - Pc[0]) / R, (ry * tt - Pc[1]) / R, (rz * tt - Pc[2]) / R];
          const nb = [Rt[0][0] * n[0] + Rt[1][0] * n[1] + Rt[2][0] * n[2], Rt[0][1] * n[0] + Rt[1][1] * n[1] + Rt[2][1] * n[2], Rt[0][2] * n[0] + Rt[1][2] * n[1] + Rt[2][2] * n[2]];
          const lam = Math.max(0, -(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) * -1);
          acc += 95 + 150 * lam - 55 * tex(nb); cov++;
        }
        if (cov) gray[y * W + x] = Math.max(0, Math.min(255, (acc / cov) * (cov / 4) + gray[y * W + x] * (1 - cov / 4) + (rnd() - .5) * 5));
      }
    }
    if (process.env.DUMPALL) require('fs').appendFileSync(process.env.DUMPALL, Buffer.from(gray));
    if (process.env.DUMPF && fi == +process.env.DUMPF) require('fs').writeFileSync('f.pgm', Buffer.concat([Buffer.from(`P5 ${W} ${H} 255\n`), Buffer.from(gray)]));
    const out = det.process({ gray, w: W, h: H, t });
    if (out.state === 'ready' && lockedTee == null) lockedTee = out.rest.onTee;
    if (out.shot) res = out.shot;
  }
  return { res, det, lockedTee };
}

// 3D 위치(카메라 좌표) 측정 → 자세 보정 시뮬레이션: 두 공의 화면 원(중심·반지름)에서 역산
function calibrate(sc, ball2W) {
  const proj = p => { const c = sc.toCam(p); return { u: sc.W / 2 + sc.fpx * c[0] / c[2], v: sc.H / 2 + sc.fpx * c[1] / c[2], r: sc.fpx * R / c[2] }; };
  const b1 = proj(sc.ballW), b2 = proj(ball2W);
  // 앱과 같은 방식: 거리 설정(ρ)으로 초점거리 추정 후 각 공 3D 위치
  const pu = sc.W / 2, pv = sc.H / 2, D0 = 2 * R;
  const rho = Math.hypot(sc.C[0] - sc.ballW[0], sc.C[1] - sc.ballW[1], sc.C[2] - sc.ballW[2]);
  let fpx = 2 * b1.r * rho / D0;
  for (let k = 0; k < 4; k++) { const q = Math.hypot(b1.u - pu, b1.v - pv) / fpx; fpx = 2 * b1.r * rho / Math.sqrt(1 + q * q) / D0; }
  const P = b => { const Z = fpx * D0 / (2 * b.r); return [(b.u - pu) / fpx * Z, (b.v - pv) / fpx * Z, Z]; };
  return D.poseFromTwo(P(b1), P(b2));
}

function report(label, out, truth) {
  const r = out.res, f = x => x == null ? '-' : x.toFixed(0);
  if (!r) { console.log(label.padEnd(30), 'NO SHOT', out.det.msg, '| tee', out.lockedTee); return; }
  const side = r.spin ? -r.spin[2] : null;
  console.log(`${label.padEnd(30)} tee:${out.lockedTee ? 'Y' : 'N'}(${(r.teeScore || 0).toFixed(2)}) fr=${r.frames} v ${r.speed.toFixed(1)}/${truth.speed} vla ${r.vla.toFixed(1)}/${truth.vla} hla ${r.hla.toFixed(1)}/${truth.hla} | ${r.spinFrom} back ${f(r.spin?.[0])}/${truth.spin[0]} side ${f(side)}/${-truth.spin[2]}`);
}
module.exports = { scene, shoot, calibrate, report };

if (require.main === module) {
  const iron = { fps: 1000, speed: 45, vla: 17, hla: 1, spin: [6000, 0, -900] };
  const drv = { fps: 1000, speed: 60, vla: 12, hla: -1, spin: [2600, 0, 500] };
  const which = process.argv[2] || 'all';
  if (which === 'all' || which === 'side') {
    let sc = scene({ pose: { phi: -90 }, tee: false });
    report('측면·지면공(7i)', shoot(sc, iron), iron);
    sc = scene({ pose: { phi: -90 }, tee: true });
    report('측면·티(드라이버)', shoot(sc, drv), drv);
  }
  if (which === 'all' || which === 'oblique') {
    for (const phi of [-60, -120]) {
      const sc = scene({ pose: { phi, pitch: 8 }, tee: true, shift: [0.1, -0.03] });
      const cal = calibrate(sc, [0, 1.0, sc.ballW[2]]);
      console.log(`  보정 φ=${cal.phi.toFixed(1)}(실제 ${phi}) pitch=${cal.pitch.toFixed(1)}(실제 8)`);
      report(`비스듬 φ${phi}·보정O`, shoot(sc, Object.assign({}, drv, { opts: { camM: cal.M } })), drv);
      report(`비스듬 φ${phi}·보정X(측면가정)`, shoot(sc, drv), drv);
    }
  }
  if (which === 'all' || which === 'behind') {
    const sc = scene({ pose: { phi: 0, pitch: 12 }, rho: 0.45, shift: [0, 0.05], tee: true });
    const cal = calibrate(sc, [0, 1.0, sc.ballW[2]]);
    console.log(`  보정 φ=${cal.phi.toFixed(1)}(실제 0) pitch=${cal.pitch.toFixed(1)}(실제 12)`);
    report('후방·보정O(드라이버)', shoot(sc, Object.assign({}, drv, { opts: { camM: cal.M } })), drv);
    const sc2 = scene({ pose: { phi: 15, pitch: 10 }, rho: 0.45, shift: [0.02, 0.05], tee: false });
    const cal2 = calibrate(sc2, [0, 1.0, sc2.ballW[2]]);
    report('후방15°·지면(7i)·보정O', shoot(sc2, Object.assign({}, iron, { opts: { camM: cal2.M } })), iron);
  }
}
