// 흑백 USB 카메라·실내 매트 장면: 흰 방해물(매트 흰 줄, 흰 카드, 큰 흰 원, 작은 흰 점, 누운 티, 신발 앞코, 반사광)
// 카메라↔공 30~50cm. 공을 제대로 고정하는지, 샷까지 이어지는지 검사
const S = require('./synth3.js');
const D = require('../detector.js');

function distractors(W, H, seed = 5) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = 58 + 10 * Math.sin(x * 0.9) * Math.sin(y * 1.1) + (rnd() - .5) * 14; // 매트 결
  const fill = (fn, v) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fn(x, y)) g[y * W + x] = Math.min(255, v + (rnd() - .5) * 8); };
  fill((x, y) => y > Math.round(H * 0.78) && y < Math.round(H * 0.78) + 14, 228);                         // 매트 흰 줄
  fill((x, y) => { const c = Math.cos(0.3), sn = Math.sin(0.3), u = (x - W * 0.72) * c + (y - H * 0.22) * sn, v = -(x - W * 0.72) * sn + (y - H * 0.22) * c; return Math.abs(u) < 40 && Math.abs(v) < 24; }, 236); // 흰 카드(기울어진 직사각형)
  fill((x, y) => (x - W * 0.17) ** 2 + (y - H * 0.24) ** 2 < 56 * 56, 232);                                // 큰 흰 원(컵 바닥 등, 공보다 훨씬 큼)
  fill((x, y) => (x - W * 0.88) ** 2 + (y - H * 0.62) ** 2 < 7 * 7, 240);                                  // 작은 흰 점(볼마커)
  fill((x, y) => Math.abs(y - H * 0.92) < 3 && x > W * 0.55 && x < W * 0.65, 225);                       // 누운 티
  fill((x, y) => ((x - W * 0.95) / 90) ** 2 + ((y - H * 0.95) / 45) ** 2 < 1, 215);                        // 신발 앞코(화면 모서리)
  fill((x, y) => ((x - W * 0.45) / 18) ** 2 + ((y - H * 0.1) / 7) ** 2 < 1, 250);                          // 반사광(가로로 긴 타원)
  fill((x, y) => (x - W * 0.6) ** 2 + (y - H * 0.45) ** 2 < 15 * 15 && Math.abs(x - W * 0.6) < 11, 230);   // 잘린 원(D자, 공 크기 비슷한 흰 조각)
  return g;
}

function setup({ rho = 0.4, W = 640, H = 480, fpx = 457, tee = false, shift = [0.05, -0.02], flatDisk = false } = {}) {
  const sc = S.scene({ pose: { phi: -90 }, rho, W, H, fpx, shift, tee });
  const bg = distractors(W, H);
  // 티는 scene()이 원래 배경에 그려 두었으므로 그 픽셀만 옮겨 온다
  if (tee) for (let i = 0; i < W * H; i++) if (sc.bg[i] === 215) bg[i] = 215;
  if (flatDisk) { // 공과 같은 크기의 평평한 흰 원판(볼마커·병뚜껑 등)
    const rr = fpx * 0.021335 / rho;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - W * 0.42) ** 2 + (y - H * 0.6) ** 2 < rr * rr) bg[y * W + x] = 228 + ((x * 7 + y * 13) % 5);
  }
  sc.bg = bg;
  return sc;
}

function lockTest(label, sc, opts = {}) {
  const det = new D.ShotDetector(Object.assign({ camDist: Math.hypot(sc.C[0] - sc.ballW[0], sc.C[1] - sc.ballW[1], sc.C[2] - sc.ballW[2]) }, opts));
  const c = sc.toCam(sc.ballW), tu = sc.W / 2 + sc.fpx * c[0] / c[2], tv = sc.H / 2 + sc.fpx * c[1] / c[2], tr = sc.fpx * 0.021335 / c[2];
  const out = S.shoot(sc, { fps: 1000, speed: 45, vla: 17, hla: 1, spin: [6000, 0, -900], opts: Object.assign({ camDist: det.o.camDist }, opts) });
  const r = out.det.lastRest;
  const okLock = r && Math.hypot(r.cx - tu, r.cy - tv) < tr * 0.3;
  console.log(`${label.padEnd(28)} 공(${tu.toFixed(0)},${tv.toFixed(0)} r${tr.toFixed(1)}) 고정: ${r ? `${r.cx.toFixed(0)},${r.cy.toFixed(0)} r${r.r.toFixed(1)}` : '없음'} ${okLock ? '✓' : '✗'} | 샷: ${out.res ? `v ${out.res.speed.toFixed(1)}/45 vla ${out.res.vla.toFixed(1)}/17 ${out.res.spinFrom} side ${out.res.spin ? (-out.res.spin[2]).toFixed(0) : '-'}/900` : '없음 (' + out.det.msg + ')'}`);
  return out;
}
module.exports = { setup, lockTest, distractors };

if (require.main === module) {
  const extra = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  for (const rho of [0.3, 0.4, 0.5]) lockTest(`흑백 매트 ρ=${rho}m`, setup({ rho }), extra);
  lockTest('흑백 매트 ρ=0.4 티', setup({ rho: 0.4, tee: true }), extra);
  lockTest('흑백 ρ=0.4 공 아래쪽', setup({ rho: 0.4, shift: [-0.06, -0.06] }), extra);
  lockTest('같은 크기 흰 원판 함께', setup({ rho: 0.4, flatDisk: true }), extra);
}
