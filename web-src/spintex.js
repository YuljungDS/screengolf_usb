// ===== 표면 텍스처(딤플·로고·마커) 기반 3축 스핀 추정 =====
// 원리: 공 영상의 밝기 패턴을 구면에 역투영한 뒤, 다음 프레임과 가장 잘 겹치는 3D 회전을 찾는다.
//  - 조명에 의한 음영은 카메라에 고정되어 있고 딤플 무늬는 공과 함께 돈다 → 고역통과(국소 평균 제거)로 음영 제거
//  - 프레임 쌍마다 회전벡터 φ를 거친 격자 → 미세 언덕오르기로 탐색(정규화 상호상관, NCC)
//  - 딤플은 준주기 무늬라 가짜 정답(앨리어싱)이 생길 수 있으므로, 여러 프레임 간격(1·2·3칸)에서
//    같은 각속도 ω가 동시에 맞는지 검사해 하나로 확정
// 좌표: 카메라 좌표(x 오른쪽, y 아래, z 화면 안쪽). 구면 위 점 q = [dx, dy, -sqrt(1-dx²-dy²)] (카메라 쪽 반구)
const SpinTex = (() => {
  const DEG = Math.PI / 180;

  function boxBlur(src, W, H, k) {
    // 적분영상 기반 박스 평균 (반경 k)
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += src[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - k), y1 = Math.min(H, y + k + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - k), x1 = Math.min(W, x + k + 1);
        const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
        out[y * W + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  // 추적된 공 하나의 주변을 잘라 고역통과 영상 두 단계(미세/거친)를 만든다
  function crop(f, b) {
    const r = b.r;
    if (r < 6) return null;
    const half = Math.ceil(r * 1.15) + 2;
    const x0 = Math.round(b.cx) - half, y0 = Math.round(b.cy) - half, W = half * 2 + 1, H = W;
    if (x0 < 0 || y0 < 0 || x0 + W > f.w || y0 + H > f.h) return null;
    const g = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f.gray[(y0 + y) * f.w + x0 + x];
    // 공 안쪽 픽셀만으로 국소 평균(정규화 합성곱) → 공/배경 경계가 무늬로 섞이지 않게
    const cx = b.cx - x0, cy = b.cy - y0, mk = new Float32Array(W * H), gm = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= (r * 0.95) ** 2) { mk[i] = 1; gm[i] = g[i]; }
    }
    // 1) 조명 음영 제거: 구면 법선의 2차 다항식(9항)으로 밝기를 최소제곱 근사해 뺀다
    //    (한쪽 조명이면 단순 국소평균만으로는 음영 기울기가 남아 회전축이 기울어 보임)
    const NB = 9, AtA = new Float64Array(NB * NB), Atb = new Float64Array(NB), basis = new Float64Array(NB);
    const fillB = (x, y) => { const z = -Math.sqrt(Math.max(0, 1 - x * x - y * y)); basis[0] = 1; basis[1] = x; basis[2] = y; basis[3] = z; basis[4] = x * y; basis[5] = x * z; basis[6] = y * z; basis[7] = x * x; basis[8] = y * y; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!mk[i]) continue;
      fillB((x - cx) / r, (y - cy) / r);
      for (let p = 0; p < NB; p++) { Atb[p] += basis[p] * g[i]; for (let q = 0; q < NB; q++) AtA[p * NB + q] += basis[p] * basis[q]; }
    }
    const coef = solve(AtA, Atb, NB);
    const res = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!mk[i]) continue;
      fillB((x - cx) / r, (y - cy) / r);
      let v = 0; for (let p = 0; p < NB; p++) v += coef[p] * basis[p];
      res[i] = g[i] - v;
    }
    // 2) 남은 저주파 제거(공 안쪽만 쓰는 정규화 합성곱)
    const k = Math.max(2, Math.round(r * 0.16));
    const lo = boxBlur(res, W, H, k), lm = boxBlur(mk, W, H, k);
    const hp = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) hp[i] = mk[i] ? res[i] - lo[i] / Math.max(1e-3, lm[i]) : 0;
    const hpc = boxBlur(hp, W, H, Math.max(1, Math.round(r * 0.05)));
    return { x0, y0, W, H, hp, hpc, cx: b.cx - x0, cy: b.cy - y0, ax: b.cx, ay: b.cy, r };
  }

  function solve(A, b, n) { // 가우스 소거 (부분 피벗)
    const M = Array.from({ length: n }, (_, i) => [...A.slice(i * n, i * n + n), b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-9;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((row, i) => row[n] / (row[i] || 1e-9));
  }

  function sample(img, W, H, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W - 1 || yi >= H - 1) return NaN;
    const fx = x - xi, fy = y - yi, i = yi * W + xi;
    return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + W] * (1 - fx) + img[i + W + 1] * fx) * fy;
  }

  function rotm(p) { // 회전벡터 → 행렬 (Rodrigues)
    const th = Math.hypot(p[0], p[1], p[2]);
    if (th < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const x = p[0] / th, y = p[1] / th, z = p[2] / th, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    return [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
      y * x * C + z * s, c + y * y * C, y * z * C - x * s,
      z * x * C - y * s, z * y * C + x * s, c + z * z * C];
  }

  // 원근 보정: 공 중심을 향한 시선 방향 d로 카메라 z축을 돌리는 회전 V (열벡터 행렬, 행 우선 9개)
  // 공이 화면을 가로지르면 시선이 바뀌어, 보정하지 않으면 '가짜 사이드스핀'이 생긴다.
  function viewRot(tex, cam) {
    if (!cam) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const d = [(tex.ax - cam.pu) / cam.fpx, (tex.ay - cam.pv) / cam.fpx, 1];
    const l = Math.hypot(d[0], d[1], d[2]); d[0] /= l; d[1] /= l; d[2] /= l;
    // z=[0,0,1] → d 최소 회전: 축 = z × d = [-d1, d0, 0]
    const ax = [-d[1], d[0], 0], s = Math.hypot(ax[0], ax[1]);
    if (s < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    return rotm([ax[0] / s * Math.asin(s), ax[1] / s * Math.asin(s), 0]);
  }
  const mv = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
  const mtv = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];

  // B 프레임 표본점(카메라 좌표 구면점 + 밝기) 준비
  function points(B, stride, coarse) {
    const img = coarse ? B.hpc : B.hp, pts = [];
    const R = B.r * 0.86;
    for (let y = Math.ceil(B.cy - R); y <= B.cy + R; y += stride) for (let x = Math.ceil(B.cx - R); x <= B.cx + R; x += stride) {
      const dx = (x - B.cx) / B.r, dy = (y - B.cy) / B.r, q = dx * dx + dy * dy;
      if (q > 0.74) continue;
      const c = mv(B.V, dx, dy, -Math.sqrt(1 - q));
      pts.push(c[0], c[1], c[2], img[y * B.W + x]);
    }
    return new Float32Array(pts);
  }

  // A를 회전 φ만큼 돌렸을 때 B와의 NCC (겹치는 면적이 작으면 감점)
  function score(A, P, phi, coarse) {
    const img = coarse ? A.hpc : A.hp;
    const m = rotm(phi);
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const N = P.length / 4;
    for (let i = 0; i < P.length; i += 4) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      // q_A = Rᵀ q_B
      const gx = m[0] * x + m[3] * y + m[6] * z, gy = m[1] * x + m[4] * y + m[7] * z, gz = m[2] * x + m[5] * y + m[8] * z;
      const L = A.V; // 카메라 좌표 → A의 국소(시선) 좌표
      const ax = L[0] * gx + L[3] * gy + L[6] * gz, ay = L[1] * gx + L[4] * gy + L[7] * gz, az = L[2] * gx + L[5] * gy + L[8] * gz;
      if (az > -0.3) continue; // A에서 보이지 않거나 가장자리
      const a = sample(img, A.W, A.H, A.cx + ax * A.r, A.cy + ay * A.r);
      if (a !== a) continue;
      const b = P[i + 3];
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < Math.max(12, N * 0.25)) return -1;
    const den = Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb)));
    const ncc = (n * sab - sa * sb) / den;
    return ncc * Math.min(1, n / (N * 0.55));
  }

  function climb(fn, start, steps) {
    let best = start.slice(), bs = fn(best);
    for (const st of steps) {
      let improved = true, guard = 0;
      while (improved && guard++ < 40) {
        improved = false;
        for (let k = 0; k < 3; k++) for (const sg of [1, -1]) {
          const c = best.slice(); c[k] += sg * st;
          const s = fn(c);
          if (s > bs) { bs = s; best = c; improved = true; }
        }
      }
    }
    return { p: best, s: bs };
  }

  // 한 쌍(A→B)의 회전 탐색
  function pair(A, B, thMax) {
    const Pc = points(B, Math.max(1, Math.round(B.r / 8)), true);
    const Pf = points(B, Math.max(1, Math.round(B.r / 14)), false);
    const step = Math.min(5 * DEG, thMax / 4);
    const cands = [];
    for (let a = -thMax; a <= thMax + 1e-9; a += step) for (let b = -thMax; b <= thMax + 1e-9; b += step) for (let c = -thMax; c <= thMax + 1e-9; c += step) {
      if (a * a + b * b + c * c > thMax * thMax) continue;
      const s = score(A, Pc, [a, b, c], true);
      if (s > 0) cands.push({ p: [a, b, c], s });
    }
    cands.sort((x, y) => y.s - x.s);
    const top = [];
    for (const c of cands) { if (top.every(t => Math.hypot(t.p[0] - c.p[0], t.p[1] - c.p[1], t.p[2] - c.p[2]) > step * 1.5)) top.push(c); if (top.length >= 6) break; }
    const res = [];
    for (const t of top) res.push(climb(p => score(A, Pf, p, false), t.p, [step / 2, step / 4, step / 8, step / 16]));
    res.sort((a, b) => b.s - a.s);
    return res.length ? { phi: res[0].p, s: res[0].s, all: res.slice(0, 4) } : null;
  }

  // 추적 프레임 목록 → 카메라 좌표 각속도 ω(rad/s)
  // 공의 스핀은 짧은 구간에서 일정하다고 보고, 모든 프레임 쌍을 동시에 가장 잘 맞추는 ω 하나를 찾는다.
  //  1) 거친 격자: 인접 프레임 쌍 전부의 점수 합 (흐린 고역통과 영상)
  //  2) 상위 후보 → 1·2·3칸 간격 쌍 전부(선명한 영상)로 언덕오르기
  function estimate(track, opts = {}) {
    const maxRpm = opts.maxRpm || 12000;
    let F = track.filter(s => s.tex);
    if (F.length < 2) return null;
    if (F.length > 10) F = F.slice(0, 10); // 계산량 제한: 임팩트 직후 10프레임 (스핀 감쇠 무시 가능)
    for (const s of F) s.tex.V = viewRot(s.tex, opts.cam);
    const near = [], all = [];
    for (let gap = 1; gap <= 3; gap++) for (let i = 0; i + gap < F.length; i++) {
      const dt = F[i + gap].t - F[i].t;
      if (dt <= 0) continue;
      const B = F[i + gap].tex;
      const L = { A: F[i].tex, dt, gap, Pf: points(B, Math.max(1, Math.round(B.r / 12)), false) };
      if (gap === 1) { L.Pc = points(B, Math.max(1, Math.round(B.r / 8)), true); near.push(L); }
      all.push(L);
    }
    if (!near.length) return null;
    const dt0 = near.reduce((a, L) => a + L.dt, 0) / near.length;
    const coarseTotal = w => { let s = 0, n = 0; for (const L of near) { const v = score(L.A, L.Pc, [w[0] * L.dt, w[1] * L.dt, w[2] * L.dt], true); if (v > -1) { s += v; n++; } } return n ? s / near.length : -1; };
    const fineTotal = w => { let s = 0, ws = 0; for (const L of all) { const v = score(L.A, L.Pf, [w[0] * L.dt, w[1] * L.dt, w[2] * L.dt], false); const k = L.gap === 1 ? 1 : 1.3; if (v > -1) s += v * k; ws += k; } return ws ? s / ws : -1; };

    const thMax = Math.min(75 * DEG, maxRpm * 2 * Math.PI / 60 * dt0); // 프레임당 최대 회전
    const step = Math.min(5 * DEG, thMax / 5);
    const cands = [];
    for (let a = -thMax; a <= thMax + 1e-9; a += step) for (let b = -thMax; b <= thMax + 1e-9; b += step) for (let c = -thMax; c <= thMax + 1e-9; c += step) {
      if (a * a + b * b + c * c > thMax * thMax) continue;
      const w = [a / dt0, b / dt0, c / dt0];
      const s = coarseTotal(w);
      if (s > 0) cands.push({ w, s });
    }
    cands.sort((x, y) => y.s - x.s);
    const top = [];
    const sw = step / dt0;
    for (const c of cands) { if (top.every(t => Math.hypot(t.w[0] - c.w[0], t.w[1] - c.w[1], t.w[2] - c.w[2]) > sw * 1.5)) top.push(c); if (top.length >= 8) break; }
    let best = null;
    for (const t of top) {
      const r = climb(fineTotal, t.w, [sw / 2, sw / 4, sw / 8, sw / 16]);
      if (!best || r.s > best.s) best = r;
    }
    if (!best) return null;
    const perFrameDeg = Math.hypot(...best.p) * dt0 / DEG;
    return { w: best.p, conf: best.s, pairs: near.length, links: all.length, perFrameDeg, maxRpm: Math.min(maxRpm, 75 / 360 * 60 / dt0) };
  }

  return { crop, estimate, rotm, viewRot, mv };
})();
if (typeof module !== 'undefined') module.exports = SpinTex;
