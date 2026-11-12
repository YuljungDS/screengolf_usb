// ===== 카메라 영상에서 골프공 검출·추적 → 발사 조건(속도·방향·3축 스핀) 산출 =====
// 가정: 카메라는 공 높이에서 타깃 라인과 수직(측면)으로 공을 바라봄.
//   화면 가로 = 진행 방향, 화면 세로 = 높이, 공의 겉보기 크기 변화 = 좌우(카메라 쪽/반대쪽) 이동
// 스핀: 공에 그린 '띠 모양 선(마커)'의 3D 자세 변화를 프레임 간 비교(TRIAD)해 회전 벡터를 구함
const Detector = (() => {
  const ST = typeof SpinTex !== 'undefined' ? SpinTex : require('./spintex.js');
  const HG = typeof Hough !== 'undefined' ? Hough : require('./hough.js');
  let BN = null; try { BN = typeof BallNet !== 'undefined' ? BallNet : require('./ballnet.js'); } catch (e) { BN = null; }
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
  // 절반 해상도(2×2 평균) — 원 검출 속도용
  function half(f) {
    const W = f.w >> 1, H = f.h >> 1, g = new Uint8Array(W * H), s = f.gray, w = f.w;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = 2 * y * w + 2 * x; g[y * W + x] = (s[i] + s[i + 1] + s[i + w] + s[i + w + 1] + 2) >> 2; }
    return { gray: g, w: W, h: H };
  }
  function pctl(g, q) {
    const hst = new Uint32Array(256); for (let i = 0; i < g.length; i += 3) hst[g[i]]++;
    const n = Math.ceil(g.length / 3); let a = 0; for (let k = 0; k < 256; k++) { a += hst[k]; if (a >= n * q) return k; } return 255;
  }
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
        stableFrames: 8, maxTrackTime: 0.3, useDepth: true, maxHla: 35, spinMode: 'auto', maxRpm: 12000,
        camM: null, // 카메라 자세(월드←카메라 3x3). null이면 '측면 수직' 가정(공 진행 방향으로 자동 판별)
        // 공 크기 조건: 예상 반지름 = kFocal·화면폭·D / (2·거리). kFocal = 초점거리(px)/화면폭 — 화각 65°면 0.785
        kFocal: 0.785, sizeTol: [0.4, 3.0], useHough: true, minInlier: 0.5, minShade: 0.035,
        useNet: true, netTemplates: null, // 학습형 판별기 사용, 사용자가 탭한 '내 공' 템플릿(정규화 16×16)
      }, opts);
      // 기본 판별기: 신경망 확률과 '내 공' 템플릿 유사도 중 큰 값
      if (!this.o.ballNet && BN) this.o.ballNet = (f, b) => {
        if (!this.o.useNet) return 1;
        const c = BN.crop(f, b.cx, b.cy, b.r);
        let p = BN.prob(c);
        const T = this.o.netTemplates;
        if (T && T.length) { const sm = BN.sim(c, T); p = Math.max(p, Math.min(1, Math.max(0, (sm - 0.55) / 0.35))); }
        return p;
      };
      this.reset();
    }
    set(opts) { if (opts.kFocal != null && opts.kFocal !== this.o.kFocal) this.wideMode = false; Object.assign(this.o, opts); }
    reset() { this.state = 'search'; this.stable = 0; this.anchor = null; this.hits = []; this.misses = 0; this.rest = null; this.cand = null; this.track = []; this.seed = this.seed || null; this.lastShot = null; this.msg = '공을 찾는 중…'; }
    setSeed(u, v) { this.seed = { u, v }; this.reset(); }

    threshold(gray) {
      if (this.o.thr > 0) return this.o.thr;
      const hist = new Uint32Array(256);
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
      const pct = q => { let acc = 0; const target = gray.length * q; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
      // 배경(중앙값)과 가장 밝은 부분(상위 0.5%)의 중간쯤: 한쪽에서 비추는 조명으로 공 일부가 어두워도 원형을 유지
      const med = pct(0.5), hi = pct(0.995);
      this.bgMed = med; this.hiLvl = hi;
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

    // 창 안의 밝은 둥근 덩어리 중 (cx,cy)에 가장 가까운 것
    localBall(f, thr, cx, cy, R) {
      const { gray, w, h } = f;
      const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
      const LW = x1 - x0 + 1, LH = y1 - y0 + 1;
      if (LW < 4 || LH < 4) return null;
      const m = new Uint8Array(LW * LH);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[(y - y0) * LW + x - x0] = gray[y * w + x] > thr * 0.85 ? 1 : 0;
      this.closeMask(m, LW, LH, Math.max(1, Math.round(this.rest.r * 0.3)));
      let best = null, bd = Infinity;
      for (const b0 of blobs(m, LW, LH, 4)) {
        const b = Object.assign({}, b0, { cx: b0.cx + x0, cy: b0.cy + y0, minx: b0.minx + x0, maxx: b0.maxx + x0, miny: b0.miny + y0, maxy: b0.maxy + y0 });
        if (b.l2 / b.l1 < 0.35) continue;
        const d = Math.hypot(b.cx - cx, b.cy - cy);
        if (d < bd) { bd = d; best = b; }
      }
      return best ? this.refine(f, best, false) : null;
    }

    // 날아가는 공 찾기: 밝기 기준(기준영상 차이만 쓰면, 후방 촬영에서 제자리에서 작아지는 공이 지워짐)
    detectMoving(f, thr) {
      const { gray, w, h } = f, ref = this.ref, r0 = this.rest.r, a0 = Math.PI * r0 * r0;
      const mask = new Uint8Array(w * h);
      // 기준영상(공이 놓여 있던 장면)과 달라진 픽셀 = 움직이는 것. 밝기 임계만 쓰면 하늘처럼 밝은 배경이 통째로 잡힘
      const dth = Math.max(12, this.o.diffThr * 0.6);
      for (let i = 0; i < w * h; i++) mask[i] = Math.abs(gray[i] - ref[i]) > dth ? 1 : 0;
      const cands = [];
      let cs = 0, cn = 0;
      for (let y = Math.ceil(this.rest.cy - r0 * 0.35); y <= this.rest.cy + r0 * 0.35; y++) for (let x = Math.ceil(this.rest.cx - r0 * 0.35); x <= this.rest.cx + r0 * 0.35; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue; const i = y * w + x; cs += Math.abs(gray[i] - ref[i]); cn++;
      }
      const holeGone = cn > 0 && cs / cn > this.o.diffThr * 0.8;
      // 공이 떠난 빈자리는 '바뀐 픽셀'로 잡히므로 지운다(안 지우면 가까이 있는 날아가는 공과 합쳐짐 — 후방 촬영)
      const RR = r0 * 1.06;
      if (holeGone) for (let y = Math.max(0, Math.floor(this.rest.cy - RR)); y <= Math.min(h - 1, this.rest.cy + RR); y++) for (let x = Math.max(0, Math.floor(this.rest.cx - RR)); x <= Math.min(w - 1, this.rest.cx + RR); x++)
        if ((x - this.rest.cx) ** 2 + (y - this.rest.cy) ** 2 <= RR * RR) mask[y * w + x] = 0;
      this.closeMask(mask, w, h, Math.max(1, Math.round(r0 * 0.3)));
      for (const b0 of blobs(mask, w, h, Math.max(4, a0 * 0.02))) {
        if (b0.n > a0 * 8) continue;
        // 움직이지 않는 밝은 물체(구름·바닥 표식 등) 제외: 기준영상과 거의 같으면 정지물
        let dsum = 0, dn = 0;
        const rr0 = Math.max(b0.r, (b0.maxx - b0.minx) / 2, (b0.maxy - b0.miny) / 2), sx = Math.max(1, Math.round(rr0 / 6));
        for (let y = b0.miny; y <= b0.maxy; y += sx) for (let x = b0.minx; x <= b0.maxx; x += sx) {
          const i = y * w + x; if (!mask[i]) continue; dsum += Math.abs(gray[i] - ref[i]); dn++;
        }
        const md = dn ? dsum / dn : 0;
        const nearRest0 = Math.hypot(b0.cx - this.rest.cx, b0.cy - this.rest.cy) < r0 * 1.6;
        if (md < this.o.diffThr * 0.5 && !nearRest0) continue;
        // 정밀화(역광·한쪽 조명이면 가장자리 원 맞춤) 후 형태 검사
        // 원래 자리에서 떨어진 공은 '바뀐 픽셀' 실루엣으로, 제자리 근처(후방 촬영 등)는 밝기/가장자리로 정밀화
        const touchRest = Math.hypot(Math.max(b0.minx - this.rest.cx, 0, this.rest.cx - b0.maxx), Math.max(b0.miny - this.rest.cy, 0, this.rest.cy - b0.maxy)) < r0 * 1.1;
        // 빈자리와 맞닿은 후보는 실루엣이 잘려 있으므로 원본 밝기 영상의 가장자리로 원 맞춤
        const b = !touchRest ? this.refine(f, b0, 'diff') : (this.edgeFit(f, b0) || this.refine(f, b0, false));
        if (b.r < r0 * 0.25 || b.r > r0 * 2.5) continue;
        if (b.minx <= 1 || b.miny <= 1 || b.maxx >= w - 2 || b.maxy >= h - 2) continue; // 화면 경계에 걸친 공은 크기 왜곡
        if (!b.edge && b.l2 / b.l1 < 0.12) continue; // 티·막대처럼 가는 물체 제외 (모션블러 공은 허용)
        { const rr = Math.max(b.r, (this.track.length ? this.track[this.track.length - 1].r * 0.95 : 0)); if (b.cx - rr < 3 || b.cy - rr < 3 || b.cx + rr > w - 3 || b.cy + rr > h - 3) continue; } // 화면 밖으로 잘린 공 제외
        const nearRest = Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy) < r0 * 1.5;
        const changed = Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy) > r0 * 0.3 || Math.abs(b.r / r0 - 1) > 0.06;
        if (nearRest && !changed) continue; // 아직 그 자리에 있는 공
        // 공이 떠난 '빈자리'(배경이 드러나 기준영상과 달라진 원) 제외: 원래 자리 중심부가 크게 바뀌었으면
        // 그 근처 후보는 빈자리. 후방 촬영에서 제자리에서 작아지는 공은 중심부가 그대로(공 위에 공)라 통과.
        if (holeGone && Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy) < r0 * 1.1) continue;
        cands.push(b);
      }
      const last = this.track[this.track.length - 1], prev = this.track[this.track.length - 2];
      if (!cands.length) return null;
      let best = null, bd = Infinity;
      for (const b of cands) {
        let d;
        if (!last) d = Math.hypot(b.cx - this.rest.cx, b.cy - this.rest.cy) + Math.abs(b.r - r0) * 2;
        else {
          let pu = last.u, pv = last.v, pr = last.r;
          if (prev) { const k = (f.t - last.t) / (last.t - prev.t); pu += (last.u - prev.u) * k; pv += (last.v - prev.v) * k; pr += (last.r - prev.r) * k; }
          d = Math.hypot(b.cx - pu, b.cy - pv) + Math.abs(b.r - pr) * 2;
          if (prev) { // 진행 방향이 뒤집히는 후보 제외
            const du = last.u - prev.u, dv = last.v - prev.v, mv = Math.hypot(du, dv);
            if (mv > r0 * 0.5 && ((b.cx - last.u) * du + (b.cy - last.v) * dv) / mv < -r0) d = Infinity;
          }
        }
        if (d < bd) { bd = d; best = b; }
      }
      return best && isFinite(bd) ? best : null;
    }

    // 공다움 검사(흑백 카메라에서 흰 물체를 공으로 착각하지 않도록):
    //  ① 윤곽: 중심에서 48방향으로 '배경과 처음 확실히 달라지는 거리'를 재서 변동계수(MAD/중앙값) — 원 ≈ 0.02, 사각형·D자 ≥ 0.08
    //  ② 입체감: 공은 구라서 안쪽이 밝고 가장자리가 어둡거나(정면 조명) 한쪽이 밝음(측면 조명) → 내부 밝기 변화가 있음.
    //     종이·흰 줄처럼 평평한 흰 면은 내부가 균일
    verify(f, b) {
      const { gray, w, h } = f, NR = 48;
      const S = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y); if (xi < 0 || yi < 0 || xi >= w - 1 || yi >= h - 1) return NaN; const fx = x - xi, fy = y - yi, i = yi * w + xi; return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy; };
      // 중심 c에서 방사선을 그어 '배경과 처음 확실히 달라지는 점'(윤곽) 수집
      const boundary = c => {
        const pts = [];
        for (let k = 0; k < NR; k++) {
          const a = k / NR * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
          let m = 0, m2 = 0, nb = 0;
          for (let rr = c.r * 1.35; rr <= c.r * 1.7; rr += 0.5) { const v = S(c.cx + ca * rr, c.cy + sa * rr); if (v === v) { m += v; m2 += v * v; nb++; } }
          if (nb < 3) continue;
          m /= nb; const sd = Math.sqrt(Math.max(0, m2 / nb - m * m)), th = Math.max(14, sd * 3);
          for (let rr = c.r * 1.3; rr >= c.r * 0.4; rr -= 0.25) {
            const v1 = S(c.cx + ca * rr, c.cy + sa * rr), v2 = S(c.cx + ca * (rr - 0.75), c.cy + sa * (rr - 0.75));
            if (Math.abs(v1 - m) > th && Math.abs(v2 - m) > th) { pts.push([c.cx + ca * (rr + 0.25), c.cy + sa * (rr + 0.25), k]); break; }
          }
        }
        return pts;
      };
      // 윤곽점 RANSAC 원 맞춤 → 원 위(±5%)에 놓인 점의 비율 = 원형도.
      // 역광으로 그늘진 쪽 윤곽이 흐려도 밝은 쪽 반원만으로 통과, 사각형은 모서리·변 때문에 30% 안팎
      let c = { cx: b.cx, cy: b.cy, r: b.r }, pts = [], inl = 0;
      let seed = 777; const rnd = n => (seed = (seed * 16807) % 2147483647) % n;
      const circ3 = (p, q, r) => {
        const d = 2 * (p[0] * (q[1] - r[1]) + q[0] * (r[1] - p[1]) + r[0] * (p[1] - q[1])); if (Math.abs(d) < 1e-6) return null;
        const a2 = p[0] * p[0] + p[1] * p[1], b2 = q[0] * q[0] + q[1] * q[1], c2 = r[0] * r[0] + r[1] * r[1];
        const ux = (a2 * (q[1] - r[1]) + b2 * (r[1] - p[1]) + c2 * (p[1] - q[1])) / d, uy = (a2 * (r[0] - q[0]) + b2 * (p[0] - r[0]) + c2 * (q[0] - p[0])) / d;
        return { cx: ux, cy: uy, r: Math.hypot(p[0] - ux, p[1] - uy) };
      };
      for (let it = 0; it < 2; it++) {
        pts = boundary(c);
        if (pts.length < 12) return { cv: 1, valid: pts.length / NR, inlier: 0, shade: 0 };
        let best = null, bn = 0;
        for (let k = 0; k < 150; k++) {
          const q = circ3(pts[rnd(pts.length)], pts[rnd(pts.length)], pts[rnd(pts.length)]);
          if (!q || q.r < b.r * 0.5 || q.r > b.r * 2) continue;
          const tol = Math.max(1, q.r * 0.05);
          let n = 0; for (const p of pts) if (Math.abs(Math.hypot(p[0] - q.cx, p[1] - q.cy) - q.r) < tol) n++;
          if (n > bn) { bn = n; best = q; }
        }
        if (!best) return { cv: 1, valid: pts.length / NR, inlier: 0, shade: 0 };
        const tol = Math.max(1, best.r * 0.05);
        const keep = pts.filter(p => Math.abs(Math.hypot(p[0] - best.cx, p[1] - best.cy) - best.r) < tol);
        c = fitCircle(keep) || best;
        inl = keep.length / NR;
      }
      // 원 밖으로 튀어나온 윤곽(모서리·타원 끝) 비율 — 공은 그늘진 쪽이 안쪽으로 들어갈 뿐 밖으로 나가지 않음
      // 원 위 윤곽이 '한 덩어리 호'인지: 공은 밝은 쪽이 연속(그늘은 한쪽), 타원은 양 끝 두 군데로 갈라짐
      const onC = new Uint8Array(NR);
      for (const p of pts) if (Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) < Math.max(1, c.r * 0.05)) onC[p[2]] = 1;
      let tot = 0; for (let k = 0; k < NR; k++) tot += onC[k];
      let bestRun = 0;
      if (tot) {
        // 빈칸 2개까지 허용하는 가장 긴 원형 연속 구간 안의 인라이어 수
        for (let s0 = 0; s0 < NR; s0++) {
          if (!onC[s0] || onC[(s0 + NR - 1) % NR]) continue;
          let cnt = 0, gap = 0;
          for (let j = 0; j < NR; j++) { const k = (s0 + j) % NR; if (onC[k]) { cnt++; gap = 0; } else if (++gap > 2) break; }
          bestRun = Math.max(bestRun, cnt);
        }
        if (tot === NR) bestRun = NR;
      }
      const arc = tot ? bestRun / tot : 0;
      const protrude = pts.filter(p => Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r > Math.max(1.5, c.r * 0.08)).length / Math.max(1, pts.length);
      const resid = pts.map(p => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r)).sort((p, q) => p - q);
      const cv = resid[Math.floor(resid.length * 0.4)] * 1.4826 / c.r;
      const valid = pts.length / NR;
      // 내부 밝기 변화(밝기 대비 표준편차) — 0.75r 안쪽만
      let s1 = 0, s2 = 0, n = 0;
      const st = Math.max(1, Math.round(c.r / 10));
      for (let y = Math.ceil(c.cy - c.r * 0.6); y <= c.cy + c.r * 0.6; y += st) for (let x = Math.ceil(c.cx - c.r * 0.6); x <= c.cx + c.r * 0.6; x += st) {
        if (x < 0 || y < 0 || x >= w || y >= h || (x - c.cx) ** 2 + (y - c.cy) ** 2 > (c.r * 0.6) ** 2) continue;
        const v = gray[y * w + x]; s1 += v; s2 += v * v; n++;
      }
      const mean = n ? s1 / n : 0, shade = n && mean > 0 ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) / mean : 0;
      // 포화(하얗게 날아감) 비율: 흑백 카메라 자동노출로 흰 공이 255로 꽉 차면 명암이 사라짐 → 입체감 검사를 할 수 없음
      let sat = 0, sn = 0;
      for (let y = Math.ceil(c.cy - c.r * 0.6); y <= c.cy + c.r * 0.6; y += st) for (let x = Math.ceil(c.cx - c.r * 0.6); x <= c.cx + c.r * 0.6; x += st) {
        if (x < 0 || y < 0 || x >= w || y >= h || (x - c.cx) ** 2 + (y - c.cy) ** 2 > (c.r * 0.6) ** 2) continue;
        sn++; if (gray[y * w + x] >= 248) sat++;
      }
      return { cv, valid, inlier: inl, protrude, arc, shade, sat: sn ? sat / sn : 0, cx: c.cx, cy: c.cy, r: c.r };
    }

    // 예상 공 반지름(px) — 처리 영상 폭 w 기준
    expectedR(w) { return this.o.kFocal * w * this.o.ballD / (2 * this.o.camDist); }

    // 티 판별: 공 바로 아래(공 반지름의 1~2.2배 구간)에 가늘고 대비가 뚜렷한 세로 줄(티)이 있는지.
    // 잔디·매트 위 공은 아래가 넓게 균일하거나(매트) 넓게 거칠어(잔디) 가는 줄이 없다.
    teeCheck(f, rest) {
      const { gray, w, h } = f, r = rest.r, cx = rest.cx;
      const ya = Math.round(rest.cy + r * 1.08), yb = Math.min(h - 1, Math.round(rest.cy + r * 2.2));
      let rows = 0, hits = 0;
      for (let y = ya; y <= yb; y++) {
        const xa = Math.max(0, Math.round(cx - r * 1.6)), xb = Math.min(w - 1, Math.round(cx + r * 1.6));
        if (xb - xa < 8) continue;
        const row = [];
        for (let x = xa; x <= xb; x++) row.push(gray[y * w + x]);
        const sorted = row.slice().sort((p, q) => p - q), med = sorted[sorted.length >> 1];
        let center = 0, wide = 0; const od = [];
        for (let x = xa; x <= xb; x++) {
          const d = Math.abs(gray[y * w + x] - med), ax = Math.abs(x - cx);
          if (ax < r * 0.35) center = Math.max(center, d);
          else if (ax > r * 0.7) od.push(d);
        }
        // 양옆 배경의 일반적인 결(중앙값) — 한쪽에 어두운 물체가 있어도 흔들리지 않게
        od.sort((p, q) => p - q); const outer = od.length ? od[od.length >> 1] : 0;
        for (let x = xa; x <= xb; x++) if (Math.abs(x - cx) < r * 0.6 && Math.abs(gray[y * w + x] - med) > center * 0.5) wide++;
        rows++;
        if (center > 18 && center > outer * 3 + 6 && wide <= r * 0.9 + 1) hits++; // 오토티 고무 티(공 지름의 ~1/3)까지
      }
      const score = rows ? hits / rows : 0;
      return { onTee: rows >= 4 && score > 0.55, score };
    }

    // 공 크기·중심 정밀화: 배경보다 조금만 밝아도 공으로 보고(그늘진 쪽 포함) 모멘트로 원을 다시 구한다.
    // 한쪽 조명으로 공의 밝은 부분만 잡히면 반지름이 작아져 속도가 크게 틀어지기 때문.
    refine(f, b, moving) {
      const { gray, w, h } = f, lo = (this.bgMed ?? 40) + 14, ref = this.ref;
      const dth = Math.max(12, this.o.diffThr * 0.6);
      const R = Math.max(b.rMaj, b.r) * 1.7 + 2;
      const x0 = Math.max(0, Math.floor(b.cx - R)), x1 = Math.min(w - 1, Math.ceil(b.cx + R));
      const y0 = Math.max(0, Math.floor(b.cy - R)), y1 = Math.min(h - 1, Math.ceil(b.cy + R));
      // 국소 마스크 → 바깥에서 채우기(flood fill)로 내부 구멍(그늘진 딤플·마커)을 메운다.
      // 구멍이 한쪽으로 몰리면 중심이 밝은 쪽으로 치우쳐, 백스핀이 사이드스핀처럼 보이는 오차가 생김.
      const LW = x1 - x0 + 1, LH = y1 - y0 + 1, m = new Uint8Array(LW * LH);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if ((x - b.cx) ** 2 + (y - b.cy) ** 2 > R * R) continue;
        const i = y * w + x, g = gray[i];
        if (moving === 'diff') { if (Math.abs(g - ref[i]) <= dth) continue; } // 날아가는 공: 배경 대비 바뀐 픽셀 = 공 실루엣(밝은 하늘 앞에서도 정확)
        else {
          if (g <= lo) continue;
          if (moving && ref && Math.abs(g - ref[i]) < 10) continue;
        }
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
      if (n < b.n * 0.8) return this.edgeFit(f, b) || b;
      // 그늘진 쪽이 배경(하늘 등)보다 어두우면 영역이 배경으로 새어나감 → 가장자리 원 맞춤으로 전환
      if (n > Math.PI * R * R * 0.8) return this.edgeFit(f, b) || b;
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
      if (r < b.r * 0.9 || r > b.r * 2) return this.edgeFit(f, b) || b; // 주변 물체와 섞임 → 가장자리 원 맞춤
      // 밝기 영역이 잔디 무늬 등으로 새어 둥글지 않으면 가장자리 원 맞춤 시도 (날아가는 공의 '차이' 실루엣은 번짐 때문에 길쭉할 수 있어 제외)
      if (moving !== 'diff' && l2 / l1 < 0.6) { const e = this.edgeFit(f, b); if (e) return e; }
      return Object.assign({}, b, { n, cx: ccx, cy: ccy, l1, l2, r, rMaj: 2 * Math.sqrt(l1) });
    }

    // 가장자리 원 맞춤(실외용): 밝은 부분 중심에서 방사선 64개를 그어 밝기 변화가 큰 점(경계 후보)을 모으고
    // RANSAC으로 가장 많은 후보를 지나는 원을 찾는다. 햇빛 쪽 경계(강함)만으로도 원이 정해짐.
    edgeFit(f, b) {
      const { gray, w, h } = f;
      const S = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y); if (xi < 0 || yi < 0 || xi >= w - 1 || yi >= h - 1) return NaN; const fx = x - xi, fy = y - yi, i = yi * w + xi; return (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy) + (gray[i + w] * (1 - fx) + gray[i + w + 1] * fx) * fy; };
      const rb = Math.max(3, b.r, (b.maxx - b.minx) / 2, (b.maxy - b.miny) / 2), lo = rb * 0.4, hi = rb * 2.6, NR = 64, pts = [];  // 초승달처럼 일부만 밝아도 외접 크기 기준
      for (let k = 0; k < NR; k++) {
        const a = k / NR * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
        const prof = [];
        for (let rr = lo; rr <= hi; rr += 0.5) prof.push(S(b.cx + ca * rr, b.cy + sa * rr));
        let mx = 0; const d = [];
        for (let i = 2; i < prof.length - 2; i++) { const v = (prof[i + 1] + prof[i + 2] - prof[i - 1] - prof[i - 2]) / 4; d.push(v); if (Math.abs(v) > mx) mx = Math.abs(v); }
        if (!(mx > 4)) continue;
        // 바깥쪽으로 갈수록 어두워지는(공→배경) 또는 밝아지는(그늘→하늘) 강한 변화점 상위 3개
        const c = [];
        for (let i = 1; i < d.length - 1; i++) if (Math.abs(d[i]) >= Math.abs(d[i - 1]) && Math.abs(d[i]) >= Math.abs(d[i + 1]) && Math.abs(d[i]) > Math.max(6, mx * 0.35)) c.push([Math.abs(d[i]), i]);
        c.sort((p, q) => q[0] - p[0]);
        for (const [, i] of c.slice(0, 3)) { const rr = lo + (i + 2) * 0.5; pts.push([b.cx + ca * rr, b.cy + sa * rr, k]); }
      }
      if (pts.length < 12) return null;
      let best = null, bestN = 0, seed = 12345;
      const rnd = n => (seed = (seed * 16807) % 2147483647) % n;
      const circ3 = (p, q, r) => {
        const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx = r[0], cy = r[1];
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-6) return null;
        const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
        const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
        return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
      };
      for (let it = 0; it < 300; it++) {
        const c = circ3(pts[rnd(pts.length)], pts[rnd(pts.length)], pts[rnd(pts.length)]);
        if (!c || c.r < rb * 0.8 || c.r > rb * 2.4) continue;
        if (Math.hypot(c.cx - b.cx, c.cy - b.cy) > c.r * 0.8) continue; // 밝은 부분이 원 안쪽에 있어야
        const seen = new Set(); let n = 0;
        for (const p of pts) if (!seen.has(p[2]) && Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) < 1.0) { seen.add(p[2]); n++; }
        if (n > bestN) { bestN = n; best = c; }
      }
      if (!best || bestN < NR * 0.28) return null;
      // 2단계: 찾은 원의 중심에서 다시 방사선을 그어 [0.75r, 1.3r]에서 가장 강한 경계 하나씩 → 최소제곱 원, 2회 반복
      let c = best, support = bestN / NR;
      for (let pass = 0; pass < 4; pass++) {
        const ep = [];
        for (let k = 0; k < NR; k++) {
          const a = k / NR * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
          const tx = -sa, ty = ca; // 접선 방향 3점 평균
          const I = (rr) => { let v = 0; for (let t = -1; t <= 1; t++) v += S(c.cx + ca * rr + tx * t, c.cy + sa * rr + ty * t); return v / 3; };
          // 바깥 배경(1.35r~1.7r)의 평균·흔들림을 재고, 바깥에서 안쪽으로 오며 배경과 확실히 달라지는 첫 지점 = 공 윤곽
          let m = 0, m2 = 0, nb = 0;
          for (let rr = c.r * 1.35; rr <= c.r * 1.7; rr += 0.5) { const v = I(rr); if (v === v) { m += v; m2 += v * v; nb++; } }
          if (nb < 4) continue;
          m /= nb; const sd = Math.sqrt(Math.max(0, m2 / nb - m * m));
          const th = Math.max(14, sd * 3);
          let bm = 0, br = 0;
          for (let rr = c.r * 1.3; rr >= c.r * 0.75; rr -= 0.25) {
            const v1 = I(rr), v2 = I(rr - 0.75);
            if (Math.abs(v1 - m) > th && Math.abs(v2 - m) > th) { br = rr + 0.25; bm = Math.abs(v2 - m) / (sd + 1); break; }
          }
          if (bm > 0) ep.push([c.cx + ca * br, c.cy + sa * br, bm]);
        }
        if (ep.length < NR * 0.4) break;
        // 원에서 많이 벗어난 점(잔디 무늬 등) 제외 후 적합
        const dev = ep.map(p => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r)).sort((x, y) => x - y);
        const tol = Math.max(1, dev[Math.floor(dev.length * 0.6)] * 2);
        const smax = Math.max(...ep.map(p => p[2]));
        // 강한 경계(햇빛 쪽·하늘 쪽 윤곽)만으로 맞춤 — 반원만 있어도 원은 잘 정해짐
        const keep = ep.filter(p => p[2] >= Math.min(3, smax * 0.3) && Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= tol).map(p => [p[0], p[1]]);
        const c2 = keep.length >= 10 ? fitCircle(keep) : null;
        support = keep.length / NR;
        if (!c2 || c2.r < rb * 0.7 || c2.r > rb * 2.6) break;
        c = c2;
      }
      // 공 검증: 밝은 부분이 원 밖으로 삐져나오지 않고(구름 등 긴 물체 제외),
      // 원 지름의 2/3 이상을 차지해야(밝은 덩어리보다 훨씬 큰 원을 억지로 맞춘 경우 제외)
      const maxDim = Math.max(b.maxx - b.minx, b.maxy - b.miny) + 1;
      if (maxDim > c.r * 2 + 3 || maxDim < c.r * 1.33) return null;
      if (support < 0.3) return null;
      return Object.assign({}, b, { cx: c.cx, cy: c.cy, r: c.r, rMaj: c.r, l1: c.r * c.r / 4, l2: c.r * c.r / 4, n: Math.round(Math.PI * c.r * c.r), edge: true, q: support });
    }

    // 흰 공 내부 마커(어두운 선) 때문에 생기는 구멍을 메움: 3x3 팽창 후 침식
    closeMask(mask, w, h, iter = 1) {
      // 팽창→침식(닫힘)을 (2k+1)² 정사각 창의 합으로 계산 — 반복 횟수와 무관하게 O(화소 수)
      const k = Math.max(1, iter | 0), n = w * h;
      const tmp = this._cmT && this._cmT.length === n ? this._cmT : (this._cmT = new Int32Array(n));
      const box = (src, dst) => { // dst = (2k+1)×(2k+1) 창 안의 합 (화면 밖은 0)
        for (let y = 0; y < h; y++) {
          const o = y * w; let acc = 0;
          for (let x = 0; x < Math.min(k, w); x++) acc += src[o + x];
          for (let x = 0; x < w; x++) { if (x + k < w) acc += src[o + x + k]; tmp[o + x] = acc; if (x - k >= 0) acc -= src[o + x - k]; }
        }
        for (let x = 0; x < w; x++) {
          let acc = 0;
          for (let y = 0; y < Math.min(k, h); y++) acc += tmp[y * w + x];
          for (let y = 0; y < h; y++) { if (y + k < h) acc += tmp[(y + k) * w + x]; dst[y * w + x] = acc; if (y - k >= 0) acc -= tmp[(y - k) * w + x]; }
        }
      };
      const S = this._cmS && this._cmS.length === n ? this._cmS : (this._cmS = new Int32Array(n));
      const A = this._cmA && this._cmA.length === n ? this._cmA : (this._cmA = new Uint8Array(n));
      box(mask, S);
      for (let i = 0; i < n; i++) A[i] = S[i] > 0 ? 1 : 0;
      box(A, S);
      const full = (2 * k + 1) * (2 * k + 1);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // 화면 가장자리 근처는 창이 잘리므로 원래 값 유지(가장자리 덩어리는 어차피 제외됨)
        if (x < k || y < k || x >= w - k || y >= h - k) continue;
        mask[i] = S[i] === full ? 1 : 0;
      }
    }

    // 공 후보 수집·평가(밝기 덩어리 + 원 검출) → 가장 공다운 후보
    collect(f, thr, over = {}) {
      const { gray, w, h } = f;
      // 임계값 두 단계로 후보 수집: 기본값 + (밝은 하늘·구름이 기본값 근처일 때를 위한) 가장 밝은 부분 기준 높은 값
      const thrs = [thr];
      const rExp = over.rExp || this.expectedR(w);
      // 오래(약 1.5초) 못 찾으면 크기 범위를 넓힘 — 실제 화각·거리가 설정과 다를 때
      if ((this.noFind || 0) > 45) this.wideMode = true; // 한 번 넓히면 크기를 학습할 때까지 유지
      const wide = !!this.wideMode;
      const tol = over.tol || (wide ? [Math.min(0.3, this.o.sizeTol[0]), Math.max(3.5, this.o.sizeTol[1])] : this.o.sizeTol);
      this.rExp = rExp; this.tolNow = tol; this.diag = [];
      const D = (b, why) => { if (this.diag.length < 40) this.diag.push({ cx: b.cx, cy: b.cy, r: b.r, why }); };
      { const T2 = Math.max(this.hiLvl - 55, thr + 0.35 * (this.hiLvl - thr)); if (T2 > thr + 4) thrs.push(T2); }
      const bs = [];
      for (const T of thrs) {
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) mask[i] = gray[i] > T ? 1 : 0;
        this.closeMask(mask, w, h, this.cand ? Math.max(2, Math.round(this.cand.r * 0.4)) : Math.max(2, Math.round(w / 100))); // 마커 띠로 둘로 갈라진 공도 하나로
        // 실외: 하늘·구름·반사 등 밝은 덩어리가 많으므로 '가장 큰 것' 대신 둥근 정도·화면 경계·이전 위치로 점수화
        for (const b of blobs(mask, w, h, 10)) {
          if (!(b.n < w * h * 0.08 && b.minx > 2 && b.miny > 2 && b.maxx < w - 3 && b.maxy < h - 3)) continue;
          // 크기 조건(밝은 부분이 너무 크거나 작으면 정밀화 전에 바로 제외)
          const rawR = Math.max(b.maxx - b.minx, b.maxy - b.miny) / 2;
          if (!this.seed && (rawR > rExp * tol[1] * 1.25 || rawR < rExp * tol[0] * 0.4)) { if (rawR > 3) D({ cx: b.cx, cy: b.cy, r: rawR }, '크기'); continue; }
          let r = this.refine(f, b, false);
          if (!(r.l2 / r.l1 > 0.6 && discFill(r) > 0.7 && discFill(r) < 1.3 && r.r >= 4 && r.r < h / 4)) {
            // 하얀 티·그림자 등이 붙어 덩어리 모양이 틀어진 경우: 윤곽 원 맞춤으로 공만 다시 찾아봄
            const seedR = Math.min(rawR, Math.max(b.r, rExp));
            const v = this.verify(f, { cx: b.cx, cy: b.cy - (b.maxy - b.miny > b.maxx - b.minx ? (b.maxy - b.miny - (b.maxx - b.minx)) / 2 : 0), r: seedR });
            if (v.inlier >= 0.6 && v.protrude <= 0.2 && v.r >= 4) r = Object.assign({}, r, { cx: v.cx, cy: v.cy, r: v.r, rMaj: v.r, l1: v.r * v.r / 4, l2: v.r * v.r / 4, n: Math.round(Math.PI * v.r * v.r) });
            else { D(r, '모양'); continue; }
          }
          if (!this.seed && (r.r < rExp * tol[0] || r.r > rExp * tol[1])) { D(r, '크기'); continue; }
          if (bs.some(q => Math.hypot(q.cx - r.cx, q.cy - r.cy) < q.r * 0.5)) continue; // 같은 공 중복
          const vf = this.verify(f, r);
          r.vcv = vf.cv; r.vvalid = vf.valid; r.vshade = vf.shade; r.vin = vf.inlier; r.vsat = vf.sat;
          if (!this.seed && (vf.inlier < this.o.minInlier || vf.protrude > 0.2)) { D(r, '원 아님'); continue; } // 윤곽이 원이 아님(사각형·타원·D자·뭉개진 덩어리)
          // 안쪽이 균일한 평평한 흰 면(종이·원판·흰 줄) 제외 — 단 공이 하얗게 포화되면 명암이 없어지므로 그때는 검사하지 않음
          if (!this.seed && vf.sat < 0.3 && vf.shade < this.o.minShade) { D(r, '평평'); continue; }
          // 윤곽 원 맞춤이 더 정확하면 그 원을 사용(밝기 영역이 매트 결로 새어 중심이 틀어진 경우)
          if (vf.inlier >= this.o.minInlier && vf.r) {
            if (!this.seed && (vf.r < rExp * tol[0] || vf.r > rExp * tol[1])) { D(r, '크기'); continue; }
            r.cx = vf.cx; r.cy = vf.cy; r.r = vf.r;
          }
          if (this.o.ballNet) { r.net = this.o.ballNet(f, r); if (!this.seed && r.net < 0.3) { D(r, '학습판별'); continue; } } // 학습형 판별기
          bs.push(r);
        }
      }
      // ── 원 검출(그래디언트 허프): 밝기와 무관하게 '공 크기의 둥근 윤곽'을 후보로 추가
      //    흰 책상·흰 벽·흰 박스 앞의 흰 공처럼 밝기 덩어리로는 공이 분리되지 않을 때
      if (this.o.useHough) {
        const sc2 = w >= 480 ? 2 : 1;
        const rLo = this.seed ? 6 : rExp * tol[0], rHi = this.seed ? h / 3 : Math.min(h / 3, rExp * tol[1]);
        const fh = sc2 === 2 ? half(f) : f;
        for (const c of HG.circles(fh, rLo / sc2, rHi / sc2, { maxN: 20 })) {
          const q = { cx: c.cx * sc2, cy: c.cy * sc2, r: c.r * sc2, hough: true };
          if (bs.some(b => Math.hypot(b.cx - q.cx, b.cy - q.cy) < b.r * 0.4 && Math.abs(b.r - q.r) < b.r * 0.3)) continue;
          bs.push(q);
        }
      }
      // ── 모든 후보를 같은 기준으로 평가: 윤곽 원형(그래디언트) · 밝기(흰 공) · 구 음영 · 가는 선 아님
      const p90 = this.p90 = pctl(gray, 0.9);
      for (let i = bs.length - 1; i >= 0; i--) {
        const b = bs[i];
        const hs = HG.score(f, b);
        const drop = why => { D(b, why); bs.splice(i, 1); };
        if (!hs.ok) { if (b.hough) { drop(hs.why === '경계' ? '화면 경계' : '윤곽 약함'); continue; } b.hs = null; continue; }
        b.hs = hs;
        // 밝기 덩어리 후보도 윤곽이 원이어야 함(신발 앞코처럼 일부만 둥근 흰 물체 제외)
        if (!b.hough && !this.seed && (hs.inlier < 0.4 || hs.gap > 0.45)) { drop('원 아님(윤곽)'); continue; }
        if (b.hough) {
          b.cx = hs.cx; b.cy = hs.cy; b.r = hs.r;
          if (this.seed) continue;
          if (b.r < rExp * tol[0] || b.r > rExp * tol[1]) { drop('크기'); continue; }
          if (hs.inlier < 0.42 || hs.gap > 0.4) { drop('원 아님'); continue; }
          if (hs.lineFrac > 0.5) { drop('가는 선(고리)'); continue; }
          if (hs.mean < 0.45 * p90) { drop('어두움'); continue; }
          if (hs.sat > 0.5) { drop('포화(조명·하늘)'); continue; }
          if (hs.shadeAmp > 0.45 && hs.r2 < 0.5) { drop('얼룩·물체'); continue; }
          if (hs.sat < 0.3 && hs.shadeAmp < 0.012 && hs.resid < 3) { drop('평평'); continue; } // 종이 원판·스티커: 구 음영도 딤플 결도 없음
          b.vin = hs.inlier; b.vshade = Math.max(0.02, hs.shadeAmp); b.vsat = hs.sat; b.vcv = 0; b.vvalid = true;
          if (this.o.ballNet) { b.net = this.o.ballNet(f, b); if (b.net < 0.6) { drop('학습판별'); continue; } } // 밝기 덩어리 검사를 거치지 않은 윤곽 후보라 판별기 확신이 필요
        }
      }
      // 겹친 두 원은 둘 다 공일 수 없음(공 두 개면 중심 간격 ≥ 지름) → 판별기 확신이 뚜렷이 낮은 쪽 제외(공에 겹친 원판·공 일부를 포함한 원)
      if (!this.seed) for (let i = bs.length - 1; i >= 0; i--) {
        const a = bs[i]; if (a.net == null) continue;
        if (bs.some(b => b !== a && b.net != null && b.net > a.net + 0.1 && Math.hypot(a.cx - b.cx, a.cy - b.cy) < 1.2 * Math.max(a.r, b.r))) { D(a, '겹침(다른 공 후보가 더 확실)'); bs.splice(i, 1); }
      }
      this.noFind = bs.length ? 0 : (this.noFind || 0) + 1;
      this.cands = bs;
      let best = null;
      if (this.seed) { let bd = Infinity; for (const b of bs) { const d = Math.hypot(b.cx - this.seed.u, b.cy - this.seed.v); if (d < bd && d < Math.max(30, b.r * 4)) { bd = d; best = b; } } }
      else {
        let bsc = -1;
        const prev = this.lastRest;
        for (const b of bs) {
          // 점수: 윤곽 원형도 × 예상 크기와의 일치 × 입체감(평평한 흰 면 감점)
          const round = Math.min(1, (b.vin || 0) / 0.85);
          const sizeFit = Math.exp(-0.5 * (Math.log(b.r / rExp) / (wide ? 0.9 : 0.6)) ** 2);
          const shadeFit = b.vsat >= 0.3 ? 0.7 : Math.min(1, 0.25 + b.vshade / 0.06);
          const netFit = b.net != null ? 0.02 + 0.98 * b.net ** 6 : 1; // 학습 판별기(실제 프레임 보강) 비중 강화
          let sc = round * sizeFit * shadeFit * netFit;
          const hs = b.hs;
          if (hs) {
            // 그래디언트 윤곽이 또렷하고 원형일수록, 장면에서 밝은 편(흰 공)일수록 가점
            const edgeFit = Math.min(1, hs.edge / 30), circFit = Math.min(1, hs.inlier / 0.65) * (1 - Math.min(0.5, hs.gap));
            const brightFit = Math.max(0.15, Math.min(1, (hs.mean / Math.max(1, p90) - 0.35) / 0.45));
            const lineFit = 1 - Math.min(0.8, hs.lineFrac);
            // 구 음영: 흰 공은 완만한 명암(0.02~0.14). 그보다 강하면 모서리·물체 경계일 가능성
            //   단, 햇빛에선 공도 명암이 강함 → 구 모델로 잘 설명되면(R²↑) 감점 안 함
            const sphereFit = hs.sat >= 0.3 ? 0.8 : (hs.shadeAmp <= 0.14 || hs.r2 >= 0.65) ? 1 : Math.max(0.3, Math.exp(-(((hs.shadeAmp - 0.14) / 0.08) ** 2)));
            // 결(딤플·글자) 크기: 공은 잔결이 작음 — 망·글씨판·복잡한 물체는 큼
            const rel = hs.resid / Math.max(30, hs.mean);
            const texFit = Math.max(0.4, Math.min(1, 1 - (rel - 0.12) / 0.15));
            sc *= edgeFit * circFit * brightFit * lineFit * sphereFit * texFit;
            b.hsf = { edgeFit, circFit, brightFit, lineFit, sphereFit, texFit };
          } else sc *= 0.5;
          b.score = sc; b.sizeFit = sizeFit; b.round = round; b.shadeFit0 = shadeFit;
          if (prev && Math.hypot(b.cx - prev.cx, b.cy - prev.cy) < prev.r * 3 && Math.abs(b.r - prev.r) < prev.r * 0.3) sc *= 3; // 직전 공 위치 근처 우대(카메라가 조금 흔들려도 빨리 재고정)
          b.adj = sc;
          if (sc > bsc) { bsc = sc; best = b; }
        }
        // 매트(지면) 공 우선: 오토티에 새 공이 올라와 공이 2개 보이면 티 위 공을 감점
        if (best && bs.length > 1 && this.o.preferGround !== false) {
          const top = bs.filter(b => b.adj > best.adj * 0.05).sort((p, q) => q.adj - p.adj).slice(0, 4);
          for (const b of top) { const tc = this.teeCheck(f, b); b.onTee = tc.onTee; }
          // 매트 공은 오토티 공과 크기가 비슷하고(±35%) 화면에서 비슷한 높이이거나 더 아래, 판별기도 확신(≥0.8)해야 함 — 구름·하늘 조각 제외
          const ground = top.filter(b => !b.onTee && b !== best && Math.abs(b.r - best.r) < best.r * 0.35 && b.cy > best.cy - best.r * 2 && (b.net == null || b.net >= 0.8));
          if (best.onTee && ground.length && ground[0].adj >= best.adj * 0.25) { best = ground[0]; best.preferredGround = true; }
        }
      }
      return { bs, best, rExp, tol, wide };
    }

    // 프레임 처리. f = { gray:Uint8Array, w, h, t(초) }
    process(f) {
      const { gray, w, h, t } = f;
      // 임계값은 공 탐색 단계에서만 다시 계산(준비·추적 단계는 고정)
      const thr = (this.state === 'search' || !this.lastThr) ? this.threshold(gray) : this.lastThr;
      this.lastThr = thr;
      let shot = null;

      if (this.state === 'search') {
        const { best, rExp, tol, wide } = this.collect(f, thr);
        // 고정 판정(흔들림 허용): 기준 후보 근처로 반복 검출되면 누적, 가끔 빗나가는 건 3번까지 봐줌
        const near = (a, c) => Math.hypot(a.cx - c.cx, a.cy - c.cy) < Math.max(1.5, c.r * 0.2) && Math.abs(a.r - c.r) < Math.max(1, c.r * 0.15);
        if (best && this.anchor && near(best, this.anchor)) { this.hits.push(best); this.misses = 0; }
        else if (++this.misses > 3 || !this.anchor) { this.anchor = best; this.hits = best ? [best] : []; this.misses = 0; }
        this.stable = this.hits ? this.hits.length - 1 : 0;
        this.cand = best;
        this.msg = best ? `공 감지됨 — 고정 확인 중 (${this.stable}/${this.o.stableFrames})` : `공을 찾는 중… 예상 지름 ${(rExp * 2).toFixed(0)}px (${(rExp * 2 * tol[0]).toFixed(0)}~${(rExp * 2 * tol[1]).toFixed(0)})${wide ? ' · 범위 넓혀 찾는 중' : ''} — 공을 탭하면 지정·크기 학습`;
        if (best && this.stable >= this.o.stableFrames) {
          const med = k => { const a = this.hits.map(h => h[k]).sort((p, q) => p - q); return a[a.length >> 1]; };
          this.rest = { sat: best.vsat || 0, net: best.net, cx: med('cx'), cy: med('cy'), r: med('r'), edge: this.hits.filter(h => h.edge).length * 2 > this.hits.length, t };
          const tee = this.teeCheck(f, this.rest);
          this.rest.onTee = tee.onTee; this.rest.teeScore = tee.score;
          this.lastRest = this.rest;
          // 사용자가 탭으로 지정한 공이면 크기를 학습(초점거리 비율) → 이후 자동 탐색이 이 크기 근처만 찾음
          if (this.seed) {
            this.learnedK = 2 * this.rest.r * this.o.camDist / (this.o.ballD * w);
            if (BN) this.learnedTemplate = BN.zvec(BN.crop(f, this.rest.cx, this.rest.cy, this.rest.r)).slice(); // '내 공' 모습 저장용
          }
          this.lockRest(f, thr);
          this.msg = `준비 완료 (${tee.onTee ? '티 위 공' : '지면 공'}) — 스윙하세요${this.rest.sat > 0.5 ? ' · ⚠ 공이 하얗게 포화됨: 조명/노출을 낮춰야 스핀 측정 가능' : ''}`;
        }
      } else if (this.state === 'ready') {
        const frac = this.discFrac(f, thr);
        // 임팩트 판단: ① 정지 위치에서 공이 사라짐(측면 촬영) ② 공이 그 자리에서 작아지거나 커짐·조금 이동(후방/정면 촬영)
        let moved = frac < this.restFrac * 0.4;
        if (!moved) {
          // 공이 놓였던 원 안의 밝기 변화(기준영상 대비, 주변 밝기 변화만큼 보정 — 구름·해 가림에 덜 민감)
          // 잡음·작은 흔들림으로 오작동하지 않도록 2프레임 연속일 때만
          const md = this.discDiff(f);
          if (md > Math.max(8, this.o.diffThr * 0.3)) { if (++this.moveN >= 2) moved = true; }
          else { this.moveN = 0; if (++this.readyN % 45 === 0) { this.ref = new Uint8Array(gray); this.restFrac = this.discFrac(f, thr); } } // 실외 밝기 변화(구름 등)에 맞춰 기준 영상 갱신
        }
        if (moved) {
          this.state = 'track'; this.tImpact = t; this.track = []; this.miss = 0; this.dirSign = this.o.dir === 'right' ? 1 : this.o.dir === 'left' ? -1 : 0;
          this.msg = '임팩트 감지 — 추적 중';
          this.trackFrame(f, thr);
        } else if (this.rest.onTee && this.o.preferGround !== false && ++this.sceneN % 10 === 0) {
          // 티 위 공에 고정된 상태에서 매트에 새 공이 놓이면 그 공으로 옮김(가벼운 장면 비교 → 변화가 멈췄을 때만 공 찾기)
          const ch = this.sceneChange(f);
          if (ch) {
            this.chN = (this.chN || 0) + 1;
            if (this.chN >= 2 && ch.still) {
              const nb = this.findNewGroundBall(f, thr, ch);
              if (nb) {
                const tee = this.teeCheck(f, nb);
                this.rest = { sat: nb.vsat || 0, net: nb.net, cx: nb.cx, cy: nb.cy, r: nb.r, edge: false, t, onTee: tee.onTee, teeScore: tee.score };
                this.lastRest = this.rest;
                this.lockRest(f, thr);
                this.msg = '매트 위 공으로 변경 — 준비 완료 (지면 공) — 스윙하세요';
              } else this.sceneRef = new Uint8Array(gray); // 공이 아닌 변화(사람·클럽 등)는 기준에 반영 → 같은 변화로 다시 찾지 않음
              this.chN = 0;
            }
          } else this.chN = 0;
        }
      } else if (this.state === 'track') {
        this.trackFrame(f, thr);
        const done = (this.track.length && this.miss >= 3) || t - this.tImpact > this.o.maxTrackTime;
        if (done) {
          // 결과를 바로 내지 않고, 원래 자리에 공이 그대로 있는지 먼저 확인(연습 스윙·명암 변화·몸에 잠깐 가려짐)
          this.pending = this.track.length >= 2 ? this.computeShot(w, h) : null;
          this.state = 'verify'; this.tVerify = t; this.presN = 0; this.absN = 0;
          this.msg = '공이 그 자리에 있는지 확인 중…';
        }
      } else if (this.state === 'verify') {
        const pr = this.present(f);
        if (pr) { this.presN++; this.absN = 0; } else { if (!this.absN) this.tAbs = t; this.absN++; this.presN = 0; }
        if (this.presN >= 2) {
          // 공이 그대로 있음 → 샷이 아님. 고정 유지(기준 영상만 현재 밝기로 갱신)
          this.lockRest(f, thr, true);
          this.msg = `공 유지 (${this.pending && this.pending.ok ? '연습 스윙' : '움직임·명암 변화'}) — 준비 완료 (${this.rest.onTee ? '티 위 공' : '지면 공'}) — 스윙하세요`;
          this.pending = null;
        } else if (this.pending && ((this.absN >= 4 && t - this.tAbs >= 0.06) || this.absN >= 12)) { // 클럽이 잠깐 가린 것과 구분: 약 0.06초(또는 12프레임) 이상 계속 없음
          // 공이 자리에서 사라짐 + 궤적 있음 → 실제 샷
          shot = this.pending; this.lastShot = shot; this.pending = null;
          if (shot.ok && !this.o.kLearned) this.learnedK = 2 * this.rest.r * this.o.camDist / (this.o.ballD * w); /* 실제로 날아간 공 = 확실한 공 → 크기 자동 학습 */
          this.state = 'cool'; this.tCool = t; this.msg = shot.ok ? '샷 계산 완료' : '샷 계산 실패: ' + shot.reason;
        } else if (!this.pending && this.absN >= 3 && t - this.tVerify > 3) {
          // 궤적 없이 3초 넘게 공이 안 보임 → 공을 치웠거나 옮김 → 다시 찾기
          this.msg = '공이 자리에 없음 — 다시 찾는 중'; this.lastFail = { t, n: this.track.length };
          this.state = 'search'; this.stable = 0; this.cand = null; this.anchor = null; this.hits = []; this.misses = 0;
        }
      } else if (this.state === 'cool') {
        if (t - this.tCool > 1.5) { this.reset(); this.msg = '다음 공을 올려놓으세요'; }
      }
      return { state: this.state, msg: this.msg, rest: this.rest, cand: this.cand, track: this.track, shot, thr };
    }

    discDiff(f) {
      const { gray, w, h } = f, r = this.rest, ref = this.ref;
      // 주변 고리(1.6~2.4r)의 밝기 비율(중앙값)로 전체 밝기 변화를 보정
      const rat = [];
      for (let k = 0; k < 48; k++) {
        const a = k / 48 * 6.2832, d = r.r * (k % 2 ? 1.6 : 2.4);
        const x = Math.round(r.cx + Math.cos(a) * d), y = Math.round(r.cy + Math.sin(a) * d);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x; if (ref[i] > 12) rat.push(gray[i] / ref[i]);
      }
      rat.sort((p, q) => p - q);
      const g = rat.length >= 12 ? Math.max(0.5, Math.min(2, rat[rat.length >> 1])) : 1;
      let s = 0, n = 0;
      const st = Math.max(1, Math.round(r.r / 10));
      for (let y = Math.ceil(r.cy - r.r); y <= r.cy + r.r; y += st) for (let x = Math.ceil(r.cx - r.r); x <= r.cx + r.r; x += st) {
        if (x < 0 || y < 0 || x >= w || y >= h || (x - r.cx) ** 2 + (y - r.cy) ** 2 > r.r * r.r) continue;
        const i = y * w + x; s += Math.abs(gray[i] - Math.min(255, ref[i] * g)); n++;
      }
      return n ? s / n : 0;
    }

    // 영상이 끝났을 때 확인 중이던 샷 내보내기(공이 사라졌는지 볼 프레임이 없을 때)
    flush() {
      if (this.state === 'verify' && this.pending && this.presN === 0) { const s = this.pending; this.pending = null; this.lastShot = s; this.state = 'cool'; return s; }
      return null;
    }

    // 고정(또는 고정 유지) 시 기준 저장: 기준 영상, 공 모습(존재 확인용), 장면 기준
    lockRest(f, thr, keep) {
      const { gray } = f;
      this.ref = new Uint8Array(gray);
      this.restFrac = this.discFrac(f, thr);
      this.restPatch = this.patch(f, this.rest.cx, this.rest.cy, this.rest.r);
      this.sceneRef = new Uint8Array(gray);
      this.readyN = 0; this.moveN = 0; this.sceneN = 0; this.chN = 0; this.chPrev = null;
      this.state = 'ready';
    }

    // 공 둘레 ±1.3r을 20×20으로 표본(평균 0·분산 1로 정규화) — 밝기·대비가 바뀌어도 같은 공이면 상관이 높음
    patch(f, cx, cy, r) {
      const { gray, w, h } = f, N = 20, v = new Float32Array(N * N);
      let m = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = Math.round(cx + ((i + 0.5) / N * 2 - 1) * 1.3 * r), y = Math.round(cy + ((j + 0.5) / N * 2 - 1) * 1.3 * r);
        const q = gray[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))]; v[j * N + i] = q; m += q;
      }
      m /= N * N; let sd = 0; for (let k = 0; k < v.length; k++) { v[k] -= m; sd += v[k] * v[k]; }
      sd = Math.sqrt(sd / v.length); this.lastPatchSd = sd;
      for (let k = 0; k < v.length; k++) v[k] /= Math.max(2, sd);
      return v;
    }
    // 고정한 공이 아직 그 자리에 있는지: 공 모습 상관(작은 흔들림 허용) ≥ 0.75
    present(f) {
      const r = this.rest, P = this.restPatch; if (!P) return false;
      let best = -1;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const q = this.patch(f, r.cx + dx * r.r * 0.05, r.cy + dy * r.r * 0.05, r.r);
        if (this.lastPatchSd < 3) continue; // 아무 무늬도 없음(가려짐·포화)
        let c = 0; for (let k = 0; k < q.length; k++) c += q[k] * P[k];
        best = Math.max(best, c / q.length);
      }
      this.lastPresence = best;
      return best >= 0.75;
    }

    // 장면 변화(고정한 공 주변 제외): 거친 격자로 기준 장면과 비교 → 바뀐 칸 묶음의 중심·크기, 직전 확인 이후 멈췄는지
    sceneChange(f) {
      const { gray, w, h } = f, ref = this.sceneRef, r = this.rest; if (!ref) return null;
      const st = Math.max(4, Math.round(r.r / 3));
      // 전체 밝기 변화 보정(중앙값 비율)
      const rat = [];
      for (let y = st; y < h; y += st * 3) for (let x = st; x < w; x += st * 3) { const i = y * w + x; if (ref[i] > 12) rat.push(gray[i] / ref[i]); }
      rat.sort((p, q) => p - q); const g = rat.length ? Math.max(0.5, Math.min(2, rat[rat.length >> 1])) : 1;
      let n = 0, tot = 0, sx = 0, sy = 0, mv = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      const pv = this.prevScene;
      for (let y = st; y < h - st; y += st) for (let x = st; x < w - st; x += st) {
        tot++;
        if (Math.hypot(x - r.cx, y - r.cy) < r.r * 1.8) continue;
        const i = y * w + x;
        if (Math.abs(gray[i] - Math.min(255, ref[i] * g)) > 28) { n++; sx += x; sy += y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); if (pv && Math.abs(gray[i] - pv[i]) > 20) mv++; }
      }
      this.prevScene = new Uint8Array(gray);
      if (n > tot * 0.3) { this.sceneRef = new Uint8Array(gray); return null; } // 화면 대부분이 바뀜 = 조명·카메라 → 기준 갱신
      if (n < 3) return null;
      const cx = sx / n, cy = sy / n;
      return { cx, cy, n, g, box: [x0, y0, x1, y1], still: mv <= Math.max(1, n * 0.15) };
    }

    // 바뀐 영역만 잘라 공 후보를 찾고, 기준 장면에 없던(새로 놓인) 지면 공만 고름
    findNewGroundBall(f, thr, ch) {
      const { gray, w, h } = f, r = this.rest, m = Math.round(r.r * 2.5);
      const X0 = Math.max(0, ch.box[0] - m), Y0 = Math.max(0, ch.box[1] - m), X1 = Math.min(w, ch.box[2] + m), Y1 = Math.min(h, ch.box[3] + m);
      const cw = X1 - X0, chh = Y1 - Y0; if (cw < r.r * 3 || chh < r.r * 3) return null;
      const sub = new Uint8Array(cw * chh);
      for (let y = 0; y < chh; y++) sub.set(gray.subarray((Y0 + y) * w + X0, (Y0 + y) * w + X0 + cw), y * cw);
      // collect의 부수효과(진단·못 찾음 횟수 등) 보존
      const keep = { diag: this.diag, rExp: this.rExp, tolNow: this.tolNow, noFind: this.noFind, wideMode: this.wideMode, p90: this.p90, cands: this.cands, cand: this.cand, lastRest: this.lastRest };
      this.cand = null; this.lastRest = null;
      let bs = [];
      try { bs = this.collect({ gray: sub, w: cw, h: chh, t: f.t }, thr, { rExp: r.r, tol: [0.65, 1.5] }).bs; } finally { Object.assign(this, keep); }
      const ref = this.sceneRef;
      const isNew = b => { // 기준 장면의 같은 자리와 모양(정규화 상관)이 다르면 새로 놓인 물체
        const P = this.patch({ gray: ref, w, h }, b.cx, b.cy, b.r), Q = this.patch(f, b.cx, b.cy, b.r);
        let c = 0; for (let k = 0; k < P.length; k++) c += P[k] * Q[k];
        return c / P.length < 0.5;
      };
      const out = bs.map(b => Object.assign({}, b, { cx: b.cx + X0, cy: b.cy + Y0 }))
        .filter(b => Math.hypot(b.cx - r.cx, b.cy - r.cy) > r.r * 1.5 && Math.abs(b.r - r.r) < r.r * 0.35 && (b.net == null || b.net > 0.5) && isNew(b))
        .sort((p, q) => (q.adj || 0) - (p.adj || 0));
      return out.find(b => !this.teeCheck(f, b).onTee) || null;
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
      this.miss = 0;
      const lt = this.track[this.track.length - 1];
      if (lt && Math.hypot(b.cx - lt.u, b.cy - lt.v) < this.rest.r * 0.08 && Math.abs(b.r - lt.r) < this.rest.r * 0.02) { this.miss++; return; } // 멈춰 있는 것은 날아가는 공이 아님
      const blur = b.l1 / b.l2;
      const mk = blur < 1.6 ? this.marker(f, b) : null;
      // 딤플 텍스처용 잘라낸 영상 (모션 블러가 크면 무늬가 지워지므로 제외)
      const tex = (this.o.spinMode !== 'marker' && blur < 1.4) ? ST.crop(f, b) : null;
      this.track.push({ t: f.t, u: b.cx, v: b.cy, r: b.r, edge: !!b.edge, blur, mk, tex });
    }

    computeShot(w, h) {
      const o = this.o, pu = w / 2, pv = h / 2;
      // 가장자리 원 맞춤 반지름은 원근 타원(바깥쪽으로 1/cosθ 늘어남)의 평균 → 짧은 반지름으로 환산
      const minorR = (r, u, v, edge, fp) => { if (!edge) return r; const q = Math.hypot(u - pu, v - pv) / fp, c = 1 / Math.sqrt(1 + q * q); return r * 2 / (1 + 1 / c); };
      let r0 = this.rest.r;
      // 초점거리(px): 사용자가 잰 값은 카메라↔공 직선거리 ρ0 → 깊이 Z0 = ρ0·cosθ0 로 바꿔 f = 2·r0·Z0/D (θ0도 f에 의존 → 반복)
      let fpx = 2 * r0 * o.camDist / o.ballD;
      for (let k = 0; k < 4; k++) {
        r0 = minorR(this.rest.r, this.rest.cx, this.rest.cy, this.rest.edge, fpx);
        const q = Math.hypot(this.rest.cx - pu, this.rest.cy - pv) / fpx;
        fpx = 2 * r0 * o.camDist / Math.sqrt(1 + q * q) / o.ballD;
      }
      const z0 = fpx * o.ballD / (2 * r0);
      // 크기 이상치(가림·경계·잔상) 제거
      // 1/r(= 깊이)은 시간에 대해 거의 직선 → 중앙값 기울기 직선에서 12% 이상 벗어난 프레임 제거
      // (후방·정면 촬영처럼 공 크기가 크게 변해도 정상 프레임은 유지)
      const T = this.track, inv = T.map(s => 1 / s.r);
      let slope = 0;
      { const sl = []; for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (T[j].t > T[i].t) sl.push((inv[j] - inv[i]) / (T[j].t - T[i].t)); sl.sort((a, b) => a - b); slope = sl.length ? sl[sl.length >> 1] : 0; }
      const icpt = (() => { const a = T.map((s, k) => inv[k] - slope * s.t).sort((p, q) => p - q); return a[a.length >> 1]; })();
      const tr = T.filter((s, k) => Math.abs(inv[k] - (icpt + slope * s.t)) / (icpt + slope * s.t) < 0.12);
      if (tr.length < 2) return { ok: false, reason: '유효 프레임 부족', frames: tr.length, spinPairs: 0 };
      // 공 크기(반지름)는 잡음이 크므로 평균 후 선형적합
      const P = tr.map(s => {
        // 구의 상은 타원이며 짧은 반지름 b = f·R/Z (Z = 깊이) → refine()이 b를 돌려줌
        const tx = (s.u - pu) / fpx, ty = (s.v - pv) / fpx;
        const Z = o.useDepth ? fpx * o.ballD / (2 * minorR(s.r, s.u, s.v, s.edge, fpx)) : z0;
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
      // 카메라 좌표 → 월드(ENU: x 오른쪽, y 전방, z 위)
      // 보정된 카메라 자세가 있으면 그대로, 없으면 '측면 수직' 가정에서 공이 화면 어느 쪽으로 갔는지로 결정
      if (!this.dirSign) this.dirSign = Math.sign(tr[tr.length - 1].u - tr[0].u) || 1;
      const s = this.dirSign;
      const M = o.camM || (s > 0 ? [[0, 0, -1], [1, 0, 0], [0, -1, 0]] : [[0, 0, 1], [-1, 0, 0], [0, -1, 0]]);
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
      const maxRpm = o.clubMax ? (this.rest.onTee ? o.clubMax.tee : o.clubMax.ground) : o.maxRpm; // 티 위(드라이버)는 낮은 스핀만 탐색 → 더 안정
      if (o.spinMode !== 'marker') { try { te = ST.estimate(tr, { maxRpm, cam: { fpx, pu, pv } }); } catch (e) { console.warn(e); te = null; } }
      if (te && te.conf >= 0.3 && te.links >= 3) { /* 쌍 1개뿐이면 일관성 검사가 안 되므로 버림 */ spin = toRpm(te.w); spinFrom = 'texture'; spinConf = te.conf; spinMax = te.maxRpm; }
      else if (markerSpin && o.spinMode === 'marker') { spin = markerSpin; spinFrom = 'marker'; } // 자동 모드는 텍스처(마커도 텍스처로 처리)만 신뢰
      const dtTot = tr[tr.length - 1].t - tr[0].t;
      const ok = speed > 3 && speed < 95 && vla > -10 && vla < 70;
      return { ok, reason: ok ? '' : `비정상 값 (속도 ${speed.toFixed(1)} m/s, 발사각 ${vla.toFixed(1)}°)`, onTee: !!this.rest.onTee, teeScore: this.rest.teeScore || 0, posed: !!o.camM, speed, vla, hla, spin, spinFrom, spinConf, spinMax, texPairs: te ? te.pairs : 0, frames: tr.length, spinPairs: ws.length, dtTot, fpx };
    }
  }
  // 카메라 자세: 방위 φ(타깃 방향 기준, 카메라가 바라보는 방향, +는 오른쪽으로 돌아감), 아래로 숙임 pitch, 기울어짐 roll (도)
  //  φ=0: 공 뒤에서 타깃을 바라봄(후방) · φ=-90: 공 오른편에서 왼쪽을 바라봄(공이 화면 오른쪽으로 진행)
  //  φ=+90: 공 왼편에서 오른쪽을 바라봄(공이 화면 왼쪽으로 진행) · φ=180: 타깃 쪽에서 골퍼를 바라봄(정면)
  function camPose(phiDeg, pitchDeg = 0, rollDeg = 0) {
    const p = phiDeg * Math.PI / 180, t = pitchDeg * Math.PI / 180, rl = rollDeg * Math.PI / 180;
    const z = [Math.sin(p) * Math.cos(t), Math.cos(p) * Math.cos(t), -Math.sin(t)];
    const x0 = M3.norm(M3.cross(z, [0, 0, 1])), y0 = M3.cross(z, x0);
    const x = [0, 1, 2].map(i => x0[i] * Math.cos(rl) + y0[i] * Math.sin(rl));
    const y = [0, 1, 2].map(i => -x0[i] * Math.sin(rl) + y0[i] * Math.cos(rl));
    return [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]; // 열 = 카메라 축의 월드 방향
  }
  // 두 공(타격 위치 → 타깃 방향으로 놓은 공)의 카메라 좌표 3D 위치로 자세 보정. roll은 0(카메라 가로축 수평) 가정
  function poseFromTwo(P1, P2, pitchHint = 0) {
    const f = M3.norm([P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]]);
    // 카메라 가로축(x)이 수평이라고 보면, 위쪽 = x × f (지면 위 두 공을 잇는 선과 x축 모두에 수직)
    let u1 = M3.cross([1, 0, 0], f);
    if (u1[1] > 0) u1 = u1.map(v => -v); // 위쪽은 화면 위(-y) 쪽
    const sn = Math.hypot(u1[0], u1[1], u1[2]);
    // 두 공이 화면 가로로 나란하면(측면 촬영) 숙임 각도를 두 공으로 알 수 없음 → 입력값(pitchHint) 사용
    const p = pitchHint * Math.PI / 180, uS = [0, -Math.cos(p), -Math.sin(p)];
    const wgt = Math.min(1, sn / 0.35);
    let up = [0, 1, 2].map(i => (sn > 1e-6 ? u1[i] / sn : 0) * wgt + uS[i] * (1 - wgt));
    const k = M3.dot(up, f); up = M3.norm(up.map((v, i) => v - k * f[i]));
    const right = M3.cross(f, up);
    const M = [right, f, up]; // 행 = 월드 축의 카메라 좌표 → world = M·cam
    const zc = [M[0][2], M[1][2], M[2][2]];
    return { M, phi: Math.atan2(zc[0], zc[1]) * 180 / Math.PI, pitch: -Math.asin(Math.max(-1, Math.min(1, zc[2]))) * 180 / Math.PI };
  }
  return { ShotDetector, blobs, camPose, poseFromTwo };
})();
if (typeof module !== 'undefined') module.exports = Detector;
