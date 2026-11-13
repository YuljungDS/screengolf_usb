// ===== 번짐 줄무늬로 속도 측정 (노출 시간 고정 필요) =====
// 노출 시간 texp 동안 공이 움직인 거리 = 줄무늬 길이 - 공 지름 → 속도 = 길이 / texp
// 한 프레임만 찍혀도 속도·발사각을 구할 수 있음(120fps에서 드라이버 공은 화면에 0~1프레임만 보임).
//
// 롤링 셔터: USB 카메라는 대부분 위 행부터 차례로 찍음(행마다 노출 창이 t_row씩 늦음) → 줄무늬가 기울고 세로로 늘거나 줄어듦.
// 그래서 줄무늬 기울기를 그대로 각도로 쓰지 않고, 행마다 [창 시작, 창 끝] 동안 공이 그 화소를 덮은 시간 비율(덮임률)을
// 정확히 계산하는 모델을 관측 영상에 맞춰 (임팩트 시각, 가로·세로 속도, 행 읽기 시간)을 구한다.
//   공 중심 c(t) = c0 + v·max(0, t)   (t = 임팩트 기준 시간, c0 = 정지 위치)
//   행 y의 노출 창 = [τ0 + y·t_row − texp, τ0 + y·t_row]
//   화소 p의 덮임률 = |{t ∈ 창, t ≥ 0 : |p − c0 − v t| ≤ r}| / texp   (2차식의 해로 바로 계산)
// 관측 덮임률 = (현재 − 기준영상) / (공 밝기 − 기준영상)   (기준영상 = 임팩트 직전, 공이 정지해 있던 장면)
const Streak = (() => {
  function components(mask, w, h, minN) {
    const lab = new Int32Array(w * h), out = [], st = new Int32Array(w * h);
    let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      id++; let sp = 0; st[sp++] = i; lab[i] = id;
      const px = [];
      while (sp) {
        const j = st[--sp]; px.push(j);
        const x = j % w, y = (j / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx; if (mask[k] && !lab[k]) { lab[k] = id; st[sp++] = k; }
        }
      }
      if (px.length >= minN) out.push(px);
    }
    return out;
  }

  // 덮임률 모델(화소 하나)
  function covAt(px, py, P, M) {
    const { c0x, c0y, r2, texp } = M;
    const [tau0, vx, vy, trow] = P;
    const b = tau0 + py * trow, a = b - texp;
    if (b <= 0) return 0;
    const dx = px - c0x, dy = py - c0y;
    const A = vx * vx + vy * vy; if (A < 1e-9) return 0;
    const B = -2 * (dx * vx + dy * vy), C = dx * dx + dy * dy - r2;
    const D = B * B - 4 * A * C; if (D <= 0) return 0;
    const s = Math.sqrt(D), t1 = (-B - s) / (2 * A), t2 = (-B + s) / (2 * A);
    const lo = Math.max(a, t1, 0), hi = Math.min(b, t2);
    return hi > lo ? (hi - lo) / texp : 0;
  }

  // 예측 밝기: 기준영상 + 덮인 시간 동안 공 무늬(정지 공 사진)의 평균 − 기준영상
  //   공 무늬는 위가 밝고 아래가 어두운 음영·로고가 있어 '평균 밝기 하나'로 보면 길이가 틀어짐
  function predAt(px, py, P, M, refv) {
    const { c0x, c0y, r2, texp, ref, w } = M;
    const [tau0, vx, vy, trow] = P;
    const b = tau0 + py * trow, a = b - texp;
    if (b <= 0) return refv;
    const dx = px - c0x, dy = py - c0y;
    const A = vx * vx + vy * vy; if (A < 1e-9) return refv;
    const B = -2 * (dx * vx + dy * vy), C = dx * dx + dy * dy - r2;
    const D = B * B - 4 * A * C; if (D <= 0) return refv;
    const s = Math.sqrt(D), t1 = (-B - s) / (2 * A), t2 = (-B + s) / (2 * A);
    const lo = Math.max(a, t1, 0), hi = Math.min(b, t2);
    if (hi <= lo) return refv;
    let tex = 0; const NS = 4;
    for (let k = 0; k < NS; k++) {
      const t = lo + (k + 0.5) / NS * (hi - lo);
      const ox = Math.round(c0x + dx - vx * t), oy = Math.round(c0y + dy - vy * t); // 공 위 같은 점 = 정지 공 사진의 그 자리
      tex += ref[oy * w + ox];
    }
    tex /= NS;
    return refv + (hi - lo) / texp * (tex - refv);
  }

  // Nelder–Mead (경계는 벌점으로)
  function nm(f, x0, step, iters) {
    const n = x0.length; let S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; S.push(x); }
    let F = S.map(f);
    for (let it = 0; it < iters; it++) {
      const ord = F.map((v, i) => i).sort((a, b) => F[a] - F[b]); S = ord.map(i => S[i]); F = ord.map(i => F[i]);
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const xr = c.map((v, j) => v + (v - S[n][j])), fr = f(xr);
      if (fr < F[0]) { const xe = c.map((v, j) => v + 2 * (v - S[n][j])), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
      else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
      else {
        const xc = c.map((v, j) => v + 0.5 * (S[n][j] - v)), fc = f(xc);
        if (fc < F[n]) { S[n] = xc; F[n] = fc; }
        else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); } }
      }
    }
    let bi = 0; for (let i = 1; i <= n; i++) if (F[i] < F[bi]) bi = i;
    return { x: S[bi], f: F[bi] };
  }

  // f: {gray,w,h}, ref: 기준영상, rest: {cx,cy,r}, opt: {texp(초), fps, ballLum, tRow(알면 고정), dir(+1/-1/0)}
  function measure(f, ref, rest, opt) {
    const { gray, w, h } = f, texp = opt.texp;
    if (!(texp > 0)) return null;
    const r = rest.r, c0x = rest.cx, c0y = rest.cy;
    const B = opt.ballLum;
    // 관측 덮임률 + 가중치(공과 배경 밝기 차가 작은 곳은 정보 없음)
    // 공 무늬 밝기 범위(정지 공 사진의 5~95%) — 공이 지나간 화소는 '배경~공 무늬' 사이 값만 가능
    const tv = [];
    for (let y = -r; y <= r; y += 2) for (let x = -r; x <= r; x += 2) if (x * x + y * y < r * r * 0.85) { const xx = Math.round(c0x + x), yy = Math.round(c0y + y); if (xx >= 0 && yy >= 0 && xx < w && yy < h) tv.push(ref[yy * w + xx]); }
    tv.sort((a, b) => a - b);
    const tMin = tv[Math.floor(tv.length * 0.05)] || 0, tMax = tv[Math.floor(tv.length * 0.95)] || 255;
    const cov = new Float32Array(w * h), wt = new Float32Array(w * h), mask = new Uint8Array(w * h);
    const rIn2 = (r * 1.08) ** 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, den = B - ref[i];
      if (Math.abs(den) < 14) continue;
      const inRest = (x - c0x) ** 2 + (y - c0y) ** 2 < rIn2;
      if (inRest) continue; // 정지 공 자리(비워진 배경을 모름)는 제외
      const g = gray[i];
      if (g < Math.min(ref[i], tMin) - 22 || g > Math.max(ref[i], tMax) + 22) continue; // 클럽·몸 등 다른 물체(공일 수 없는 밝기)
      const c = (g - ref[i]) / den;
      cov[i] = Math.max(-0.5, Math.min(1.5, c)); wt[i] = Math.min(1, (Math.abs(den) - 14) / 30);
      if (c > 0.18) mask[i] = 1;
    }
    const comps = components(mask, w, h, Math.max(12, Math.round(0.3 * Math.PI * r * r)));
    if (!comps.length) return { ok: false, why: '줄무늬 없음' };
    // 후보 줄무늬: 정지 위치에서 떨어져 있고(움직임), 덮임 합이 큰 것
    const cands = comps.map(px => {
      let s = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      for (const i of px) { const x = i % w, y = (i / w) | 0, c = cov[i]; s += c; sx += x * c; sy += y * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cx = sx / s, cy = sy / s;
      return { px, s, cx, cy, box: [x0, y0, x1, y1], d: Math.hypot(cx - c0x, cy - c0y) };
    }).filter(c => c.d > 0.6 * r && c.s > 0.25 * Math.PI * r * r && (!opt.dir || Math.sign(c.cx - c0x) === opt.dir || Math.abs(c.cx - c0x) < r))
      .sort((a, b) => b.s / (1 + a.d / (30 * r)) - a.s / (1 + b.d / (30 * r))).slice(0, 3);
    if (!cands.length) return { ok: false, why: '공 줄무늬 후보 없음' };
    const trMax = 1.1 / ((opt.fps || 120) * h);
    let best = null;
    for (const cd of cands) {
      // 초기값: 정지 위치 → 줄무늬 중심 방향, 줄무늬 길이(방향으로 투영한 범위 − 지름)
      const ux = (cd.cx - c0x) / cd.d, uy = (cd.cy - c0y) / cd.d;
      let pmin = Infinity, pmax = -Infinity;
      for (const i of cd.px) { const x = i % w, y = (i / w) | 0, p = (x - c0x) * ux + (y - c0y) * uy; if (p < pmin) pmin = p; if (p > pmax) pmax = p; }
      const L0 = Math.max(0.3 * r, pmax - pmin - 1.6 * r);
      const sp0 = L0 / texp;
      const tmid = cd.d / sp0;
      const trow0 = opt.tRow != null ? opt.tRow : trMax * 0.4;
      const tau00 = tmid + texp / 2 - cd.cy * trow0;
      // 맞춤 영역: 줄무늬 둘레 + 정지 위치 둘레
      const m = Math.ceil(2 * r);
      const X0 = Math.max(0, Math.min(cd.box[0], c0x - 1.5 * r) - m) | 0, X1 = Math.min(w - 1, Math.max(cd.box[2], c0x + 1.5 * r) + m) | 0;
      const Y0 = Math.max(0, Math.min(cd.box[1], c0y - 1.5 * r) - m) | 0, Y1 = Math.min(h - 1, Math.max(cd.box[3], c0y + 1.5 * r) + m) | 0;
      const st = Math.max(1, Math.round(Math.sqrt(((X1 - X0) * (Y1 - Y0)) / 5000))); // 화소 수 제한(속도)
      const pts = [];
      for (let y = Y0; y <= Y1; y += st) for (let x = X0; x <= X1; x += st) { const i = y * w + x; if (wt[i] > 0) pts.push(x, y, cov[i], wt[i], gray[i], ref[i], 1 / Math.max(20, Math.abs(B - ref[i]))); }
      const NP = 7;
      const M = { c0x, c0y, r2: r * r, texp, ref, w };
      let sigW = 0; for (let j = 0; j < pts.length; j += NP) sigW += pts[j + 3] * Math.max(0, pts[j + 2]) ** 2;
      const fixedTr = opt.tRow != null;
      // 매개변수(서로 덜 얽히게, 기하 단위): [줄무늬 길이 L(px), 방향 θ, 기준 행에서 창 가운데 시각의 이동 거리 s(px), 행 읽기 시간, 밝기 비율]
      //   |v| = L/texp, τ0 = s/|v| + texp/2 − yRef·t_row
      const yRef = cd.cy;
      const toP = q => {
        const L = Math.max(0.5, q[0] * r), th = q[1], sp = L / texp, trw = fixedTr ? opt.tRow : q[3] * trMax;
        return [q[2] * r / sp + texp / 2 - yRef * trw, Math.cos(th) * sp, Math.sin(th) * sp, trw];
      };
      const kIdx = fixedTr ? 3 : 4;
      const loss = q => {
        const P = toP(q);
        let pen = 0;
        if (!fixedTr && (q[3] < 0 || q[3] > 1)) pen += 1e3 * (q[3] < 0 ? -q[3] : q[3] - 1);
        if (q[0] < 0.05) pen += 1e3 * (0.05 - q[0]);
        const k = q[kIdx]; pen += 4 * (k - 1) * (k - 1) * sigW; if (k < 0.75 || k > 1.25) pen += 1e3 * Math.abs(k - 1);
        let e = 0;
        for (let j = 0; j < pts.length; j += NP) {
          const rv = pts[j + 5], d = (pts[j + 4] - (rv + k * (predAt(pts[j], pts[j + 1], P, M, rv) - rv))) * pts[j + 6], ad = Math.abs(d);
          e += pts[j + 3] * (ad < 0.3 ? d * d : 0.3 * (2 * ad - 0.3)); // 후버(클럽·몸 등 다른 움직임에 둔감)
        }
        return e + pen;
      };
      const th0 = Math.atan2(uy, ux);
      const trGrid = fixedTr ? [null] : [0, 0.2, 0.4, 0.6, 0.8, 1];
      const Lgrid = []; for (let k = 0; k < 13; k++) Lgrid.push(0.3 * Math.pow(50, k / 12)); // 0.3r ~ 15r
      const seeds = [];
      for (const tr of trGrid) for (const L of Lgrid) for (const ds of [-0.5, 0, 0.5]) {
        const q = fixedTr ? [L, th0, cd.d / r + ds, 1] : [L, th0, cd.d / r + ds, tr, 1];
        seeds.push({ q, f: loss(q) });
      }
      seeds.sort((a, b) => a.f - b.f);
      const step = fixedTr ? [0.5, 0.05, 0.3, 0.1] : [0.5, 0.05, 0.3, 0.15, 0.1];
      let fit = null;
      for (const sd of seeds.slice(0, 4)) {
        let fz = nm(loss, sd.q, step.map((v, j) => j === 0 ? Math.max(0.2, sd.q[0] * 0.3) : v), 200);
        fz = nm(loss, fz.x, step.map((v, j) => (j === 0 ? Math.max(0.1, fz.x[0] * 0.1) : v * 0.3)), 150);
        if (!fit || fz.f < fit.f) fit = fz;
      }
      if (opt.truth) { // 시험용: 참값의 오차와 비교(탐색 실패인지, 원래 구분이 안 되는지)
        const T = opt.truth, spT = Math.hypot(T[1], T[2]), LT = spT * texp / r, sT = spT * (T[0] - texp / 2 + yRef * T[3]) / r, thT = Math.atan2(T[2], T[1]);
        const qt = fixedTr ? [LT, thT, sT, 1] : [LT, thT, sT, T[3] / trMax, 1];
        cd.truthLoss = loss(qt); cd.fitLoss = fit.f;
      }
      const P = toP(fit.x);
      let sig = 0; for (let j = 0; j < pts.length; j += NP) sig += pts[j + 3] * Math.max(0, pts[j + 2]) ** 2;
      const nres = fit.f / Math.max(1e-6, sig);
      const res = { ok: true, vx: P[1], vy: P[2], tau0: P[0], tRow: P[3], k: fit.x[kIdx], nres, L: Math.hypot(P[1], P[2]) * texp, n: pts.length / NP, truthLoss: cd.truthLoss, fitLoss: cd.fitLoss };
      if (!best || res.nres < best.nres) best = res;
    }
    const sp = Math.hypot(best.vx, best.vy);
    best.ok = best.nres < 0.45 && best.L > 0.25 * r && best.k > 0.45 && best.k < 1.55;
    if (!best.ok) best.why = best.L <= 0.25 * r ? '줄무늬가 너무 짧음(노출이 너무 짧거나 느린 공)' : '줄무늬 모양이 공 모델과 맞지 않음';
    best.speedPx = sp;
    return best;
  }
  return { measure, covAt };
})();
if (typeof module !== 'undefined') module.exports = Streak;
