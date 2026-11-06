// ===== 카메라 영상에서 골프공 검출·추적 → 발사 조건(속도·방향·3축 스핀) 산출 =====
// 가정: 카메라는 공 높이에서 타깃 라인과 수직(측면)으로 공을 바라봄.
//   화면 가로 = 진행 방향, 화면 세로 = 높이, 공의 겉보기 크기 변화 = 좌우(카메라 쪽/반대쪽) 이동
// 스핀: 공에 그린 '띠 모양 선(마커)'의 3D 자세 변화를 프레임 간 비교(TRIAD)해 회전 벡터를 구함
const Detector = (() => {
  const ST = typeof SpinTex !== 'undefined' ? SpinTex : require('./spintex.js');
  const M3 = {
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    // 열벡터 [a1 a2 a3] 행렬
    cols: (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]],
    mulT: (B, A) => { // B * A^T
      const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i][j] += B[i][k] * A[j][k];
      return R;
    },
    apply: (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]],
  };

  function axisAngle(R) {
    const tr = R[0][0] + R[1][1] + R[2][2];
    const th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
    if (th < 1e-6) return { th: 0, axis: [1, 0, 0] };
    const s = 2 * Math.sin(th);
    return { th, axis: M3.norm([(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s]) };
  }

  // 연결요소(블롭) 추출 + 2차 모멘트
  function blobs(mask, w, h, minArea) {
    const lab = new Int32Array(w * h);
    const out = [];
    const stack = new Int32Array(w * h);
    let id = 0;
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      id++;
      let sp = 0; stack[sp++] = i; lab[i] = id;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, minx = w, maxx = 0, miny = h, maxy = 0;
      while (sp) {
        const k = stack[--sp];
        const x = k % w, y = (k / w) | 0;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && mask[k - 1] && !lab[k - 1]) { lab[k - 1] = id; stack[sp++] = k - 1; }
        if (x < w - 1 && mask[k + 1] && !lab[k + 1]) { lab[k + 1] = id; stack[sp++] = k + 1; }
        if (y > 0 && mask[k - w] && !lab[k - w]) { lab[k - w] = id; stack[sp++] = k - w; }
        if (y < h - 1 && mask[k + w] && !lab[k + w]) { lab[k + w] = id; stack[sp++] = k + w; }
      }
      if (n < minArea) continue;
      const cx = sx / n, cy = sy / n;
      const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
      const tmp = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy * vxy);
      const l1 = (vxx + vyy) / 2 + tmp, l2 = Math.max(1e-6, (vxx + vyy) / 2 - tmp);
      out.push({ n, cx, cy, l1, l2, r: 2 * Math.sqrt(l2), rMaj: 2 * Math.sqrt(l1), minx, maxx, miny, maxy, angle: 0.5 * Math.atan2(2 * vxy, vxx - vyy) });
    }
    return out;
  }

  // 원판(공) 안쪽을 채워 흰색 공 내부의 어두운 마커 구멍까지 덮는다
  function discFill(b) { return b.n / (Math.PI * b.r * b.rMaj); }

  // 단조 사슬 볼록껍질 (px = [x0,y0,x1,y1,...]) → 꼭짓점 배열 [[x,y],...]
  function convexHull(px) {
    const P = [];
    for (let k = 0; k < px.length; k += 2) P.push([px[k], px[k + 1]]);
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    // 픽셀 모서리 보정: 꼭짓점 사이를 촘촘히 채워 원 맞춤이 고르게
    const H = lo.concat(up), out = [];
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L));
      for (let t = 0; t < n; t++) out.push([a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n]);
    }
    return out;
  }
  // 대수적 원 맞춤(Kåsa)
  function fitCircle(pts) {
    let sx = 0, sy = 0, n = pts.length;
    for (const p of pts) { sx += p[0]; sy += p[1]; }
    const mx = sx / n, my = sy / n;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const p of pts) {
      const u = p[0] - mx, v = p[1] - my;
      suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const det = suu * svv - suv * suv;
    if (Math.abs(det) < 1e-9) return null;
    const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
    const uc = (b1 * svv - b2 * suv) / det, vc = (suu * b2 - suv * b1) / det;
    return { cx: mx + uc, cy: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
  }

  class ShotDetector {
    constructor(opts = {}) {
      this.o = Object.assign({
        ballD: 0.04267, camDist: 1.0, dir: 'auto', thr: 0, diffThr: 30,
        stableFrames: 8, maxTrackTime: 0.3, useDepth: true, maxHla: 25, spinMode: 'auto', maxRpm: 12000,
      }, opts);
      this.reset();
    }
    set(opts) { Object.assign(this.o, opts); }
    reset() { this.state = 'search'; this.stable = 0; this.rest = null; this.cand = null; this.track = []; this.seed = this.seed || null; this.lastShot = null; this.msg = '공을 찾는 중…'; }
    setSeed(u, v) { this.seed = { u, v }; this.reset(); }

    threshold(gray) {
      if (this.o.thr > 0) return this.o.thr;
      const hist = new Uint32Array(256);
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
      const pct = q => { let acc = 0; const target = gray.length * q; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
      // 배경(중앙값)과 가장 밝은 부분(상위 0.5%)의 중간쯤: 한쪽에서 비추는 조명으로 공 일부가 어두워도 원형을 유지
      const med = pct(0.5), hi = pct(0.995);
      this.bgMed = med;
      return Math.max(med + 25, Math.min(235, med + 0.42 * (hi - med)));
    }

    // 공 내부 마커 → 구면 위 점들 → (중심방향 c, 선 방향 d)
    marker(f, b) {
      const { gray, w, h } = f;
      const R = b.r, pts = [];
      let sum = 0, cnt = 0;
      const x0 = Math.max(0, Math.floor(b.cx - R)), x1 = Math.min(w - 1, Math.ceil(b.cx + R));
      const y0 = Math.max(0, Math.floor(b.cy - R)), y1 = Math.min(h - 1, Math.ceil(b.cy + R));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = (x - b.cx) / R, dy = (y - b.cy) / R;
        if (dx * dx + dy * dy < 0.7) { sum += gray[y * w + x]; cnt++; }
      }
      if (cnt < 20) return null;
      const mean = sum / cnt;
      // 밝은 부분 평균을 기준으로 어두운 픽셀을 마커로
      let bs = 0, bc = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = (x - b.cx) / R, dy = (y - b.cy) / R;
        if (dx * dx + dy * dy < 0.7) { const g = gray[y * w + x]; if (g >= mean) { bs += g; bc++; } }
      }
      const bright = bs / Math.max(1, bc);
      const cut = bright * 0.6;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = (x - b.cx) / R, dy = (y - b.cy) / R;
        const q = dx * dx + dy * dy;
        if (q < 0.72 && gray[y * w + x] < cut) pts.push([dx, dy, -Math.sqrt(1 - q)]); // 카메라 쪽 반구 (z<0)
      }
      if (pts.length < 6) return null;
      let c = [0, 0, 0];
      for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
      c = M3.norm(c);
      // 주성분(멱반복)
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const p of pts) { const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += q[i] * q[j]; }
      let d = [1, 0.3, 0.1];
      for (let it = 0; it < 30; it++) d = M3.norm(M3.apply(C, d));
      // 선(띠) 모양인지 검사: 주성분 분산 비율이 낮으면 딤플 그늘 등 잡음 → 마커 아님
      const lam1 = M3.dot(d, M3.apply(C, d)), tr = C[0][0] + C[1][1] + C[2][2];
      if (tr <= 0 || lam1 / tr < 0.7 || pts.length < cnt * 0.05) return null;
      const dc = M3.dot(d, c);
      d = M3.norm([d[0] - dc * c[0], d[1] - dc * c[1], d[2] - dc * c[2]]);
      return { c, d, n: pts.length };
    }

    detectMoving(f, thr) {
      const { gray, w, h } = f, ref = this.ref;
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mask[i] = (gray[i] > thr * 0.85 && Math.abs(gray[i] - ref[i]) > this.o.diffThr) ? 1 : 0;
      this.closeMask(mask, w, h, Math.max(1, Math.round(this.rest.r * 0.3)));
      const r0 = this.rest.r, a0 = Math.PI * r0 * r0;
      const bs = blobs(mask, w, h, Math.max(4, a0 * 0.12)).filter(b => b.n < a0 * 8 && b.r > r0 * 0.35 && b.r < r0 * 2.2 &&
        Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy) > r0 * 1.2 &&
        b.minx > 1 && b.miny > 1 && b.maxx < w - 2 && b.maxy < h - 2); // 화면 경계에 걸친 공은 크기 왜곡
      if (!bs.length) return null;
      let best = null, bd = Infinity;
      const last = this.track[this.track.length - 1];
      for (const b of bs) {
        let d;
        if (!last) d = Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy);
        else {
          const prev = this.track[this.track.length - 2];
          const dt = f.t - last.t;
          let pu = last.u, pv = last.v;
          if (prev) { const k = dt / (last.t - prev.t); pu += (last.u - prev.u) * k; pv += (last.v - prev.v) * k; }
          d = Math.hypot(b.cx - pu, b.cy - pv);
          // 진행 방향 역행 후보 제외
          if (this.dirSign && (b.cx - last.u) * this.dirSign < -r0) d = Infinity;
        }
        if (d < bd) { bd = d; best = b; }
      }
      return best && isFinite(bd) ? best : null;
    }

    // 공 크기·중심 정밀화: 배경보다 조금만 밝아도 공으로 보고(그늘진 쪽 포함) 모멘트로 원을 다시 구한다.
    // 한쪽 조명으로 공의 밝은 부분만 잡히면 반지름이 작아져 속도가 크게 틀어지기 때문.
    refine(f, b, moving) {
      const { gray, w, h } = f, lo = (this.bgMed ?? 40) + 14, ref = this.ref;
      const R = Math.max(b.rMaj, b.r) * 1.7 + 2;
      const x0 = Math.max(0, Math.floor(b.cx - R)), x1 = Math.min(w - 1, Math.ceil(b.cx + R));
      const y0 = Math.max(0, Math.floor(b.cy - R)), y1 = Math.min(h - 1, Math.ceil(b.cy + R));
      // 국소 마스크 → 바깥에서 채우기(flood fill)로 내부 구멍(그늘진 딤플·마커)을 메운다.
      // 구멍이 한쪽으로 몰리면 중심이 밝은 쪽으로 치우쳐, 백스핀이 사이드스핀처럼 보이는 오차가 생김.
      const LW = x1 - x0 + 1, LH = y1 - y0 + 1, m = new Uint8Array(LW * LH);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if ((x - b.cx) ** 2 + (y - b.cy) ** 2 > R * R) continue;
        const i = y * w + x, g = gray[i];
        if (g <= lo) continue;
        if (moving && ref && Math.abs(g - ref[i]) < 10) continue;
        m[(y - y0) * LW + x - x0] = 1;
      }
      const out = new Uint8Array(LW * LH), st = [];
      for (let x = 0; x < LW; x++) { st.push(x, (LH - 1) * LW + x); }
      for (let y = 0; y < LH; y++) { st.push(y * LW, y * LW + LW - 1); }
      while (st.length) {
        const k = st.pop();
        if (out[k] || m[k]) continue;
        out[k] = 1;
        const x = k % LW, y = (k / LW) | 0;
        if (x > 0) st.push(k - 1); if (x < LW - 1) st.push(k + 1); if (y > 0) st.push(k - LW); if (y < LH - 1) st.push(k + LW);
      }
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      const px = [];
      for (let k = 0; k < LW * LH; k++) {
        if (out[k]) continue; // 바깥이 아니면 공(구멍 포함)
        const x = x0 + (k % LW), y = y0 + ((k / LW) | 0);
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; px.push(x, y);
      }
      if (n < b.n * 0.8) return b;
      const cx = sx / n, cy = sy / n;
      const vxx = sxx / n - cx * cx, vyy = syy / n - cy * cy, vxy = sxy / n - cx * cy;
      const tmp = Math.sqrt(((vxx - vyy) / 2) ** 2 + vxy * vxy);
      const l1 = (vxx + vyy) / 2 + tmp, l2 = Math.max(1e-6, (vxx + vyy) / 2 - tmp);
      let r = 2 * Math.sqrt(l2), ccx = cx, ccy = cy;
      if (l1 / l2 < 1.3) {
        // 번짐이 적으면 외곽선 기준 원 맞춤: 볼록껍질(딤플이 파먹은 오목한 홈은 건너뜀) 꼭짓점에 원을 최소제곱 적합
        const hull = convexHull(px);
        const c = hull.length >= 8 ? fitCircle(hull) : null;
        if (c && Math.hypot(c.cx - cx, c.cy - cy) < r * 0.3 && c.r > r * 0.8 && c.r < r * 1.3) {
          // 화면 가장자리의 공은 원근 때문에 바깥쪽으로 늘어난 타원 → 거리 계산에는 짧은 반지름을 쓴다
          ccx = c.cx; ccy = c.cy; r = (c.r + 0.5) * 2 / (1 + Math.sqrt(l1 / l2));
        }
        else {
          const d = new Float32Array(px.length / 2);
          for (let k = 0; k < d.length; k++) d[k] = Math.hypot(px[2 * k] - cx, px[2 * k + 1] - cy);
          d.sort();
          r = d[Math.floor(d.length * 0.95)] / 0.9747 + 0.5;
        }
      }
      if (r < b.r * 0.9 || r > b.r * 2) return b; // 주변 물체와 섞였으면 원래 값 유지
      return Object.assign({}, b, { n, cx: ccx, cy: ccy, l1, l2, r, rMaj: 2 * Math.sqrt(l1) });
    }

    // 흰 공 내부 마커(어두운 선) 때문에 생기는 구멍을 메움: 3x3 팽창 후 침식
    closeMask(mask, w, h, iter = 1) {
      const tmp = new Uint8Array(w * h);
      const pass = (src, dst, dil) => {
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          dst[i] = dil ? (src[i] | src[i - 1] | src[i + 1] | src[i - w] | src[i + w])
                       : (src[i] & src[i - 1] & src[i + 1] & src[i - w] & src[i + w]);
        }
      };
      let a = mask, b = tmp;
      for (let k = 0; k < iter; k++) { pass(a, b, true); [a, b] = [b, a]; }
      for (let k = 0; k < iter; k++) { pass(a, b, false); [a, b] = [b, a]; }
      if (a !== mask) mask.set(a);
    }

    // 프레임 처리. f = { gray:Uint8Array, w, h, t(초) }
    process(f) {
      const { gray, w, h, t } = f;
      // 임계값은 공 탐색 단계에서만 다시 계산(준비·추적 단계는 고정)
      const thr = (this.state === 'search' || !this.lastThr) ? this.threshold(gray) : this.lastThr;
      this.lastThr = thr;
      let shot = null;

      if (this.state === 'search') {
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) mask[i] = gray[i] > thr ? 1 : 0;
        this.closeMask(mask, w, h, this.cand ? Math.max(2, Math.round(this.cand.r * 0.4)) : Math.max(2, Math.round(w / 100))); // 마커 띠로 둘로 갈라진 공도 하나로
        // 한쪽 조명이면 밝은 쪽만 초승달처럼 잡히므로, 먼저 정밀화(그늘 포함)한 뒤 원형인지 검사
        const bs = blobs(mask, w, h, 10).filter(b => b.n < w * h * 0.2).map(b => this.refine(f, b, false)).filter(b => b.l2 / b.l1 > 0.55 && discFill(b) > 0.6 && discFill(b) < 1.35);
        let best = null;
        if (this.seed) { let bd = Infinity; for (const b of bs) { const d = Math.hypot(b.cx - this.seed.u, b.cy - this.seed.v); if (d < bd && d < Math.max(30, b.r * 4)) { bd = d; best = b; } } }
        else for (const b of bs) if (!best || b.n > best.n) best = b;
        if (best && this.cand && Math.hypot(best.cx - this.cand.cx, best.cy - this.cand.cy) < Math.max(1.5, best.r * 0.2) && Math.abs(best.r - this.cand.r) < Math.max(1, best.r * 0.15)) this.stable++;
        else this.stable = 0;
        this.cand = best;
        this.msg = best ? `공 감지됨 — 고정 확인 중 (${this.stable}/${this.o.stableFrames})` : '공을 찾는 중… (화면에서 공을 탭하면 지정됩니다)';
        if (best && this.stable >= this.o.stableFrames) {
          this.rest = { cx: best.cx, cy: best.cy, r: best.r, t };
          this.ref = new Uint8Array(gray);
          this.restFrac = this.discFrac(f, thr);
          this.state = 'ready';
          this.msg = '준비 완료 — 스윙하세요';
        }
      } else if (this.state === 'ready') {
        const frac = this.discFrac(f, thr);
        if (frac < this.restFrac * 0.4) {
          this.state = 'track'; this.tImpact = t; this.track = []; this.miss = 0; this.dirSign = this.o.dir === 'right' ? 1 : this.o.dir === 'left' ? -1 : 0;
          this.msg = '임팩트 감지 — 추적 중';
          this.trackFrame(f, thr);
        }
      } else if (this.state === 'track') {
        this.trackFrame(f, thr);
        const done = (this.track.length && this.miss >= 3) || t - this.tImpact > this.o.maxTrackTime;
        if (done) {
          if (this.track.length >= 2) { shot = this.computeShot(w, h); this.lastShot = shot; this.state = 'cool'; this.tCool = t; this.msg = shot.ok ? '샷 계산 완료' : '샷 계산 실패: ' + shot.reason; }
          else { this.msg = '공 궤적을 충분히 잡지 못했습니다 (프레임 수 부족) — 다시 찾는 중'; this.lastFail = { t, n: this.track.length }; this.state = 'search'; this.stable = 0; }
        }
      } else if (this.state === 'cool') {
        if (t - this.tCool > 1.5) { this.reset(); this.msg = '다음 공을 올려놓으세요'; }
      }
      return { state: this.state, msg: this.msg, rest: this.rest, cand: this.cand, track: this.track, shot, thr };
    }

    discFrac(f, thr) {
      const { gray, w } = f, r = this.rest;
      let on = 0, n = 0;
      for (let y = Math.floor(r.cy - r.r); y <= r.cy + r.r; y++) for (let x = Math.floor(r.cx - r.r); x <= r.cx + r.r; x++) {
        if ((x - r.cx) ** 2 + (y - r.cy) ** 2 > r.r * r.r * 0.6) continue;
        n++; if (gray[y * w + x] > thr * 0.85) on++;
      }
      return on / Math.max(1, n);
    }

    trackFrame(f, thr) {
      let b = this.detectMoving(f, thr);
      if (!b) { if (this.track.length) this.miss++; return; }
      b = this.refine(f, b, true);
      this.miss = 0;
      if (!this.dirSign) this.dirSign = Math.sign(b.cx - this.rest.cx) || 1;
      const blur = b.l1 / b.l2;
      const mk = blur < 1.6 ? this.marker(f, b) : null;
      // 딤플 텍스처용 잘라낸 영상 (모션 블러가 크면 무늬가 지워지므로 제외)
      const tex = (this.o.spinMode !== 'marker' && blur < 1.4) ? ST.crop(f, b) : null;
      this.track.push({ t: f.t, u: b.cx, v: b.cy, r: b.r, blur, mk, tex });
    }

    computeShot(w, h) {
      const o = this.o, r0 = this.rest.r;
      const pu = w / 2, pv = h / 2;
      // 초점거리(px): 사용자가 잰 값은 카메라↔공 직선거리 ρ0 → 깊이 Z0 = ρ0·cosθ0 로 바꿔 f = 2·r0·Z0/D (θ0도 f에 의존 → 반복)
      let fpx = 2 * r0 * o.camDist / o.ballD;
      for (let k = 0; k < 4; k++) {
        const q = Math.hypot(this.rest.cx - pu, this.rest.cy - pv) / fpx;
        fpx = 2 * r0 * o.camDist / Math.sqrt(1 + q * q) / o.ballD;
      }
      const z0 = fpx * o.ballD / (2 * r0);
      // 크기 이상치(가림·경계·잔상) 제거
      const rs = this.track.map(s => s.r).sort((a, b) => a - b);
      const rMed = rs[rs.length >> 1];
      const tr = this.track.filter(s => Math.abs(s.r - rMed) / rMed < 0.2);
      if (tr.length < 2) return { ok: false, reason: '유효 프레임 부족', frames: tr.length, spinPairs: 0 };
      // 공 크기(반지름)는 잡음이 크므로 평균 후 선형적합
      const P = tr.map(s => {
        // 구의 상은 타원이며 짧은 반지름 b = f·R/Z (Z = 깊이) → refine()이 b를 돌려줌
        const tx = (s.u - pu) / fpx, ty = (s.v - pv) / fpx;
        const Z = o.useDepth ? fpx * o.ballD / (2 * s.r) : z0;
        return { t: s.t, X: tx * Z, Y: ty * Z, Z };
      });
      const fit = key => {
        const n = P.length; let st = 0, sv = 0, stt = 0, stv = 0;
        for (const p of P) { st += p.t; sv += p[key]; stt += p.t * p.t; stv += p.t * p[key]; }
        const den = n * stt - st * st;
        return den === 0 ? 0 : (n * stv - st * sv) / den;
      };
      // 깊이(좌우 방향)는 공 크기에 의존해 잡음이 크다: 화면 가장자리 근처 프레임은 빼고, 중앙값 기울기(Theil–Sen)로 강건하게
      const PZ = P.filter((p, k) => { const sv = tr[k]; return sv.u > sv.r * 1.6 && sv.u < w - sv.r * 1.6 && sv.v > sv.r * 1.6 && sv.v < h - sv.r * 1.6; });
      const theil = (A, key) => {
        if (A.length < 2) return 0;
        const sl = [];
        for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) if (A[j].t > A[i].t) sl.push((A[j][key] - A[i][key]) / (A[j].t - A[i].t));
        sl.sort((x, y) => x - y);
        return sl.length ? sl[sl.length >> 1] : 0;
      };
      const vc = [fit('X'), fit('Y'), o.useDepth ? theil(PZ.length >= 2 ? PZ : P, 'Z') : 0];
      const s = this.dirSign;
      // 카메라 좌표 → 월드(ENU: x 오른쪽, y 전방, z 위)
      const M = s > 0 ? [[0, 0, -1], [1, 0, 0], [0, -1, 0]] : [[0, 0, 1], [-1, 0, 0], [0, -1, 0]];
      const vw = M3.apply(M, vc);
      const speed = Math.hypot(vw[0], vw[1], vw[2]);
      const vla = Math.atan2(vw[2], Math.hypot(vw[0], vw[1])) * 180 / Math.PI;
      let hla = Math.atan2(vw[0], vw[1]) * 180 / Math.PI;
      hla = Math.max(-o.maxHla, Math.min(o.maxHla, hla));

      // 스핀: 연속 프레임 마커 자세 비교
      const ws = [];
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1].mk, b = tr[i].mk;
        if (!a || !b) continue;
        const dt = tr[i].t - tr[i - 1].t;
        const A = M3.cols(a.c, a.d, M3.cross(a.c, a.d));
        let best = null;
        for (const sg of [1, -1]) {
          const d2 = [b.d[0] * sg, b.d[1] * sg, b.d[2] * sg];
          const B = M3.cols(b.c, d2, M3.cross(b.c, d2));
          const aa = axisAngle(M3.mulT(B, A));
          if (!best || aa.th < best.th) best = aa;
        }
        // 카메라 좌표계의 v축이 아래 방향이므로 회전 그대로 사용(오른손 좌표계)
        ws.push(best.axis.map(x => x * best.th / dt));
      }
      let spin = null, spinFrom = 'none', spinConf = 0, spinMax = 0;
      const toRpm = wc => M3.apply(M, wc).map(x => x * 60 / (2 * Math.PI));
      let markerSpin = null;
      if (ws.length && o.spinMode !== 'texture') {
        const med = k => { const a = ws.map(x => x[k]).sort((p, q) => p - q); return a[a.length >> 1]; };
        markerSpin = toRpm([med(0), med(1), med(2)]);
      }
      // 딤플/표면 텍스처 기반 3축 스핀
      let te = null;
      if (o.spinMode !== 'marker') { try { te = ST.estimate(tr, { maxRpm: o.maxRpm, cam: { fpx, pu, pv } }); } catch (e) { console.warn(e); te = null; } }
      if (te && te.conf >= 0.3 && te.links >= 3) { /* 쌍 1개뿐이면 일관성 검사가 안 되므로 버림 */ spin = toRpm(te.w); spinFrom = 'texture'; spinConf = te.conf; spinMax = te.maxRpm; }
      else if (markerSpin && o.spinMode === 'marker') { spin = markerSpin; spinFrom = 'marker'; } // 자동 모드는 텍스처(마커도 텍스처로 처리)만 신뢰
      const dtTot = tr[tr.length - 1].t - tr[0].t;
      const ok = speed > 3 && speed < 95 && vla > -10 && vla < 70;
      return { ok, reason: ok ? '' : `비정상 값 (속도 ${speed.toFixed(1)} m/s, 발사각 ${vla.toFixed(1)}°)`, speed, vla, hla, spin, spinFrom, spinConf, spinMax, texPairs: te ? te.pairs : 0, frames: tr.length, spinPairs: ws.length, dtTot, fpx };
    }
  }
  return { ShotDetector, blobs };
})();
if (typeof module !== 'undefined') module.exports = Detector;
