// ===== 원 검출(그래디언트 허프 변환) — 밝기와 무관하게 '공 크기의 둥근 윤곽'을 찾음 =====
// 흰 책상·흰 벽·흰 박스 앞의 흰 공처럼 밝기로는 배경과 구분되지 않을 때를 위한 후보 생성기.
// 경계 픽셀마다 밝기 변화 방향(그래디언트)으로 반지름 범위만큼 '중심 투표' → 표가 몰린 곳 = 원 중심
// → 그 중심에서 경계까지 거리 분포로 반지름 결정, 원둘레 대비 경계 비율(지지율) 계산
const Hough = (() => {
  function circles(f, rMin, rMax, opts = {}) {
    const { gray, w, h } = f;
    const maxN = opts.maxN || 12;
    rMin = Math.max(4, Math.floor(rMin)); rMax = Math.min(Math.floor(Math.min(w, h) / 2), Math.ceil(rMax));
    if (rMax <= rMin) return [];
    // 1) 3x3 평균으로 잡음 완화
    const sm = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      sm[i] = (gray[i - w - 1] + gray[i - w] + gray[i - w + 1] + gray[i - 1] + gray[i] + gray[i + 1] + gray[i + w - 1] + gray[i + w] + gray[i + w + 1]) / 9;
    }
    // 2) 소벨 그래디언트
    const mag = new Float32Array(w * h), gxA = new Float32Array(w * h), gyA = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = (sm[i - w + 1] + 2 * sm[i + 1] + sm[i + w + 1]) - (sm[i - w - 1] + 2 * sm[i - 1] + sm[i + w - 1]);
      const gy = (sm[i + w - 1] + 2 * sm[i + w] + sm[i + w + 1]) - (sm[i - w - 1] + 2 * sm[i - w] + sm[i - w + 1]);
      const m = Math.hypot(gx, gy) / 4;
      mag[i] = m; gxA[i] = gx; gyA[i] = gy;
      hist[Math.min(255, m | 0)]++;
    }
    // 경계 임계: 상위 12% 또는 최소 6 (흰 바탕 위 흰 공은 대비가 약함)
    let acc = 0, T = 6; const tot = (w - 4) * (h - 4);
    for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= tot * 0.12) { T = Math.max(6, k); break; } }
    // 3) 중심 투표(절반 해상도 누적판)
    const AW = Math.ceil(w / 2), AH = Math.ceil(h / 2), A = new Float32Array(AW * AH);
    const ex = [], ey = [], eux = [], euy = [], em = [];
    const rStep = Math.max(1, (rMax - rMin) / 48);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, m = mag[i];
      if (m < T) continue;
      // 국소 최대(가는 경계)만: 그래디언트 방향 이웃보다 크거나 같을 때
      const ux = gxA[i] / (m * 4), uy = gyA[i] / (m * 4);
      const ax = Math.round(ux), ay = Math.round(uy);
      if (mag[i + ay * w + ax] > m || mag[i - ay * w - ax] > m) continue;
      ex.push(x); ey.push(y); eux.push(ux); euy.push(uy); em.push(m);
      const wv = Math.min(1, m / (T * 3));
      for (let s = -1; s <= 1; s += 2) for (let r = rMin; r <= rMax; r += rStep) {
        const cx = x + s * ux * r, cy = y + s * uy * r;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;
        A[(cy >> 1) * AW + (cx >> 1)] += wv / Math.sqrt(r); // 큰 원이 표를 더 많이 받는 편향 완화
      }
    }
    // 4) 누적판 평활 후 국소 최대
    const B = new Float32Array(AW * AH);
    for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += A[(y + dy) * AW + x + dx];
      B[y * AW + x] = s;
    }
    const peaks = [];
    for (let y = 2; y < AH - 2; y++) for (let x = 2; x < AW - 2; x++) {
      const v = B[y * AW + x]; if (v <= 0) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && B[(y + dy) * AW + x + dx] > v) { isMax = false; break; }
      if (isMax) peaks.push([v, x * 2 + 1, y * 2 + 1]);
    }
    peaks.sort((a, b) => b[0] - a[0]);
    // 5) 각 중심에서 반지름 결정: 중심을 향하거나 등지는 경계 픽셀의 거리 분포
    const out = [];
    const nE = ex.length;
    // 매트·잔디 결처럼 잔 경계가 많으면 표 많은 봉우리가 넘쳐 공이 밀림 → 넉넉히 보고 원둘레 지지율로 다시 고름
    for (const [, pcx, pcy] of peaks.slice(0, maxN * 6)) {
      const H = new Float32Array(rMax + 3);
      for (let k = 0; k < nE; k++) {
        const dx = ex[k] - pcx, dy = ey[k] - pcy, d = Math.hypot(dx, dy);
        if (d < rMin - 1 || d > rMax + 1) continue;
        const c = Math.abs((dx * eux[k] + dy * euy[k]) / d);
        if (c < 0.85) continue;
        H[Math.round(d)] += 1;
      }
      let best = 0, br = 0;
      for (let r = rMin; r <= rMax; r++) {
        const s = (H[r - 1] + H[r] + H[r + 1]) / (2 * Math.PI * r); // 원둘레 대비 경계 비율
        if (s > best) { best = s; br = r; }
      }
      if (br && best > 0.25) out.push({ cx: pcx, cy: pcy, r: br, support: Math.min(1, best), rank: out.length });
    }
    // 표 많은 순 상위 maxN + 원둘레 지지율 높은 순 상위 maxN/2 (중복 제외)
    const byVote = out.slice(0, maxN);
    const bySup = out.slice(maxN).sort((a, b) => b.support - a.support).slice(0, Math.ceil(maxN / 2));
    return byVote.concat(bySup);
  }
  return { circles };
})();
if (typeof module !== 'undefined') module.exports = Hough;

// ===== 후보 원 평가: 그래디언트 윤곽(원형) + 구(球) 음영 + 딤플 질감 =====
// 밝기 임계와 무관 — 흰 바탕 위 흰 공, LED·하늘(평평·포화)·박스 모서리(직선) 구분용
Hough.score1 = function (f, c, opts = {}) {
  const { gray, w, h } = f;
  const at = (x, y) => { // 쌍선형 보간
    x = Math.max(0, Math.min(w - 1.001, x)); y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy;
  };
  let { cx, cy, r } = c;
  if (cx - r < 1 || cy - r < 1 || cx + r > w - 2 || cy + r > h - 2) return { ok: false, why: '경계' };
  // 1) 64방향 광선: 0.7r~1.3r에서 반지름 방향 밝기 변화가 가장 큰 곳 = 윤곽점
  const NR = 64, pts = [], sgn = [];
  let noise = 0;
  for (let k = 0; k < NR; k++) {
    const a = 2 * Math.PI * k / NR, ux = Math.cos(a), uy = Math.sin(a);
    let best = 0, bp = 0, bs = 0;
    const step = Math.max(0.5, r / 40);
    for (let d = 0.7 * r; d <= 1.3 * r; d += step) {
      const g = at(cx + ux * (d + 1.5), cy + uy * (d + 1.5)) - at(cx + ux * (d - 1.5), cy + uy * (d - 1.5));
      if (Math.abs(g) > best) { best = Math.abs(g); bp = d; bs = Math.sign(g); }
    }
    pts.push([cx + ux * bp, cy + uy * bp, best, bp]); sgn.push(bs);
  }
  const mags = pts.map(p => p[2]).sort((a, b) => a - b);
  const medMag = mags[NR >> 1];
  // 2) 강한 윤곽점들로 원 맞춤(RANSAC 3점 → 반지름 편차 기준)
  const strong = pts.filter(p => p[2] >= Math.max(4, medMag * 0.5));
  if (strong.length < NR * 0.4) return { ok: false, why: '윤곽약함', inlier: strong.length / NR };
  let bestFit = null;
  const fit3 = (p, q, s) => {
    const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx2 = s[0], cy2 = s[1];
    const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by)); if (Math.abs(d) < 1e-6) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy2) + (bx * bx + by * by) * (cy2 - ay) + (cx2 * cx2 + cy2 * cy2) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx2 - bx) + (bx * bx + by * by) * (ax - cx2) + (cx2 * cx2 + cy2 * cy2) * (bx - ax)) / d;
    return [ux, uy, Math.hypot(ax - ux, ay - uy)];
  };
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let it = 0; it < 120; it++) {
    const m = it === 0 ? null : fit3(strong[rnd(strong.length)], strong[rnd(strong.length)], strong[rnd(strong.length)]);
    const C = it === 0 ? [cx, cy, r] : m;
    if (!C || C[2] < r * 0.6 || C[2] > r * 1.4 || Math.hypot(C[0] - cx, C[1] - cy) > r * 0.4) continue;
    const tol = Math.max(1.2, C[2] * 0.06);
    let n = 0; for (const p of pts) if (p[2] >= Math.max(4, medMag * 0.5) && Math.abs(Math.hypot(p[0] - C[0], p[1] - C[1]) - C[2]) < tol) n++;
    // 각도 범위(호 길이)도 고려하도록 inlier 수 그대로 사용
    if (!bestFit || n > bestFit.n) bestFit = { C, n };
  }
  if (!bestFit) return { ok: false, why: '원맞춤실패' };
  [cx, cy, r] = bestFit.C;
  // 최종: 인라이어로 최소제곱 원(Kåsa)
  {
    const tol = Math.max(1.2, r * 0.06), P = pts.filter(p => p[2] >= Math.max(4, medMag * 0.5) && Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r) < tol);
    if (P.length >= 8) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0; const n = P.length;
      for (const [x, y] of P) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z; }
      // [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = [sxz syz sz]
      const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
      for (let i = 0; i < 3; i++) { let p = i; for (let j = i + 1; j < 3; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j; [M[i], M[p]] = [M[p], M[i]]; for (let j = 0; j < 3; j++) if (j !== i) { const q = M[j][i] / M[i][i]; for (let k = i; k < 4; k++) M[j][k] -= q * M[i][k]; } }
      const A = M[0][3] / M[0][0], B = M[1][3] / M[1][1], Cc = M[2][3] / M[2][2];
      const ncx = A / 2, ncy = B / 2, nr = Math.sqrt(Cc + ncx * ncx + ncy * ncy);
      if (isFinite(nr) && Math.abs(nr - r) < r * 0.15 && Math.hypot(ncx - cx, ncy - cy) < r * 0.15) { cx = ncx; cy = ncy; r = nr; }
    }
  }
  // 인라이어 비율·호 길이(가장 긴 연속 빈틈)
  const tol = Math.max(1.2, r * 0.07);
  const inl = pts.map(p => p[2] >= Math.max(4, medMag * 0.4) && Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r) < tol);
  const inlier = inl.filter(Boolean).length / NR;
  let gap = 0, run = 0; for (let k = 0; k < 2 * NR; k++) { if (inl[k % NR]) run = 0; else { run++; gap = Math.max(gap, run); } }
  gap = Math.min(gap, NR) / NR;
  // 가는 선(고리·전선·화면 오버레이) 판별: 윤곽 양쪽 3px 밖 밝기가 같고 가운데만 다르면 '선'
  let lineN = 0, edgeN = 0;
  for (let k = 0; k < NR; k++) {
    if (!inl[k]) continue;
    const a = 2 * Math.PI * k / NR, ux = Math.cos(a), uy = Math.sin(a), d = Math.hypot(pts[k][0] - cx, pts[k][1] - cy);
    const o = Math.max(3, r * 0.08);
    const vin = at(cx + ux * (d - o), cy + uy * (d - o)), vout = at(cx + ux * (d + o), cy + uy * (d + o));
    let vmid = at(cx + ux * d, cy + uy * d);
    for (const dd of [-1, 1]) { const v = at(cx + ux * (d + dd), cy + uy * (d + dd)); if (Math.abs(v - (vin + vout) / 2) > Math.abs(vmid - (vin + vout) / 2)) vmid = v; }
    const step = Math.abs(vout - vin), bump = Math.abs(vmid - (vin + vout) / 2);
    edgeN++; if (bump > step * 1.2 && bump > 6) lineN++;
  }
  const lineFrac = edgeN ? lineN / edgeN : 0;
  // 3) 안쪽 구 음영 맞춤: I ≈ a + b·nx + c·ny + d·nz (nz=√(1-ρ²)) — 램버트 구의 1차 근사
  //    + 잔차의 고주파(딤플·잡음) 비율
  const S = [], ys = [];
  const step = Math.max(1, r / 14);
  let sat = 0, cnt = 0;
  for (let y = -0.85 * r; y <= 0.85 * r; y += step) for (let x = -0.85 * r; x <= 0.85 * r; x += step) {
    const rho2 = (x * x + y * y) / (r * r); if (rho2 > 0.72) continue;
    const v = at(cx + x, cy + y); cnt++; if (v >= 250) sat++;
    S.push([1, x / r, y / r, Math.sqrt(1 - rho2), (x * x - y * y) / (r * r), x * y / (r * r)]); ys.push(v);
  }
  const nP = ys.length, K = 6;
  const AtA = Array.from({ length: K }, () => new Float64Array(K)), Aty = new Float64Array(K);
  for (let i = 0; i < nP; i++) for (let a = 0; a < K; a++) { Aty[a] += S[i][a] * ys[i]; for (let b = 0; b < K; b++) AtA[a][b] += S[i][a] * S[i][b]; }
  for (let a = 0; a < K; a++) AtA[a][a] += 1e-6;
  const M = AtA.map((row, i) => [...row, Aty[i]]);
  for (let i = 0; i < K; i++) { let p = i; for (let j = i + 1; j < K; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j; [M[i], M[p]] = [M[p], M[i]]; for (let j = 0; j < K; j++) if (j !== i) { const q = M[j][i] / M[i][i]; for (let k = i; k <= K; k++) M[j][k] -= q * M[i][k]; } }
  const coef = M.map((row, i) => row[K] / row[i]);
  let mean = 0; for (const v of ys) mean += v; mean /= nP;
  let vt = 0, vr = 0, vm = 0;
  for (let i = 0; i < nP; i++) { let p = 0; for (let a = 0; a < K; a++) p += coef[a] * S[i][a]; vt += (ys[i] - mean) ** 2; vr += (ys[i] - p) ** 2; vm += (p - mean) ** 2; }
  const shadeAmp = Math.sqrt(vm / nP) / Math.max(20, mean);   // 매끈한 음영의 세기(평평한 면은 ~0)
  const resid = Math.sqrt(vr / nP);                            // 맞춤 후 남는 결(딤플·글자) 크기
  const r2 = vt > 0 ? 1 - vr / vt : 0;
  // 4) 바깥 고리와 안쪽의 평균 차이·질감 비교
  let outM = 0, outN = 0;
  for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * k / 48; const v = at(cx + Math.cos(a) * r * 1.35, cy + Math.sin(a) * r * 1.35); outM += v; outN++; }
  outM /= outN;
  return { ok: true, cx, cy, r, inlier, gap, lineFrac, edge: medMag, shadeAmp, r2, resid, mean, outM, sat: cnt ? sat / cnt : 0 };
};

// 두 번 맞춤: 첫 결과(중심·반지름)에서 다시 광선을 쏴 더 나은 원을 고름(시작 원이 공보다 작거나 클 때 안쪽 음영 경계에 걸리는 것 방지)
Hough.score = function (f, c, opts = {}) {
  const a = Hough.score1(f, c, opts);
  if (!a.ok) return a;
  const q = v => v.ok ? v.inlier * (1 - v.gap) : -1;
  let best = a;
  for (const k of [1, 1.12]) {
    const b = Hough.score1(f, { cx: best.cx, cy: best.cy, r: best.r * k }, opts);
    if (q(b) > q(best) + 0.02) best = b;
  }
  return best;
};
