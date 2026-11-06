// ===== 골프공 비행 물리 엔진 =====
// 좌표계 (오른손 좌표계, ENU): x = 오른쪽(타깃 라인 기준), y = 전방(비거리), z = 위
// 스핀 벡터 ω (rad/s): ωx>0 = 백스핀, ωz>0 = 왼쪽으로 휨(훅/드로우), ωy = 라이플 스핀(진행축 회전)
const Golf = (() => {
  const BALL = { m: 0.04593, r: 0.021335 };
  BALL.A = Math.PI * BALL.r * BALL.r;
  BALL.I = 0.4 * BALL.m * BALL.r * BALL.r;
  const G = 9.81, MU_AIR = 1.81e-5;
  const RPM = 2 * Math.PI / 60;

  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
  };

  // 공력 계수: 스핀비 S = rω/v 기반 (Bearman & Harvey, Smits & Smith 실험식 근사)
  function coeffs(v, w, rho) {
    const S = BALL.r * w / Math.max(v, 0.1);
    const Re = rho * v * 2 * BALL.r / MU_AIR;
    // 저속(항력 위기 이전) 영역에서는 Cd 증가
    let cd0 = 0.225;
    if (Re < 7e4) cd0 = 0.225 + (7e4 - Re) / 7e4 * 0.25;
    const Cd = cd0 + 0.21 * S;
    const Cl = Math.min(0.40, 0.54 * Math.pow(S, 0.4)); // 멱함수형 양력곡선(포화 0.40)
    return { Cd, Cl, S, Re };
  }

  function accel(vel, w, env) {
    const rel = v3.sub(vel, env.wind);
    const v = v3.len(rel);
    const wm = v3.len(w);
    const { Cd, Cl } = coeffs(v, wm, env.rho);
    const k = 0.5 * env.rho * BALL.A / BALL.m;
    let a = [0, 0, -G];
    if (v > 1e-6) {
      a = v3.add(a, v3.mul(rel, -k * Cd * v));
      if (wm > 1e-6) {
        // 마그누스 힘: ω̂ × v̂ 방향 (라이플 성분은 v와 평행이므로 자연히 0)
        const m = v3.cross(w, rel);
        const ml = v3.len(m);
        if (ml > 1e-9) a = v3.add(a, v3.mul(m, k * Cl * v * v / ml));
      }
    }
    return a;
  }

  const SURFACES = {
    fairway: { e0: 0.38, eK: 0.016, mu: 0.6, roll: 0.3 },
    rough: { e0: 0.28, eK: 0.014, mu: 0.7, roll: 0.5 },
    green: { e0: 0.32, eK: 0.016, mu: 0.6, roll: 0.09 },
  };

  // 초기 조건 → 궤적
  // launch: { speed(m/s), vla(발사각°), hla(방향각°, +오른쪽), spin: [ωx, ωy, ωz] (rpm) }
  function simulate(launch, opts = {}) {
    const env = {
      rho: opts.rho ?? 1.225,
      wind: opts.wind ?? [0, 0, 0],
      surface: SURFACES[opts.surface || 'fairway'],
      spinTau: opts.spinTau ?? 25,
    };
    const vla = launch.vla * Math.PI / 180, hla = launch.hla * Math.PI / 180;
    let p = [0, 0, BALL.r];
    let v = [launch.speed * Math.cos(vla) * Math.sin(hla), launch.speed * Math.cos(vla) * Math.cos(hla), launch.speed * Math.sin(vla)];
    let w = launch.spin.map(s => s * RPM);
    const dt = 0.002;
    let t = 0, phase = 'flight';
    const pts = [{ t, p: p.slice(), phase }];
    let apex = p[2], landing = null, bounces = 0, lastRec = 0;
    const rec = force => { if (force || t - lastRec >= 0.016) { pts.push({ t, p: p.slice(), phase }); lastRec = t; } };

    while (t < 30) {
      if (phase === 'flight' || phase === 'bounce') {
        // 중점법(RK2)
        const a1 = accel(v, w, env);
        const vm = v3.add(v, v3.mul(a1, dt / 2));
        const a2 = accel(vm, w, env);
        p = v3.add(p, v3.mul(vm, dt));
        v = v3.add(v, v3.mul(a2, dt));
        w = v3.mul(w, Math.exp(-dt / env.spinTau));
        t += dt;
        apex = Math.max(apex, p[2]);
        if (p[2] <= BALL.r && v[2] < 0) {
          p[2] = BALL.r;
          if (!landing) landing = { t, p: p.slice(), v: v.slice(), angle: Math.atan2(-v[2], Math.hypot(v[0], v[1])) * 180 / Math.PI };
          bounce();
          bounces++;
          rec(true);
          if (Math.abs(v[2]) < 0.6 || bounces > 8) { v[2] = 0; phase = 'roll'; }
          else phase = 'bounce';
        }
        rec(false);
      } else {
        const vh = Math.hypot(v[0], v[1]);
        const dec = env.surface.roll * G * dt;
        if (vh <= dec) { v = [0, 0, 0]; t += dt; rec(true); break; }
        v = [v[0] * (1 - dec / vh), v[1] * (1 - dec / vh), 0];
        p = v3.add(p, v3.mul(v, dt));
        t += dt;
        rec(false);
      }
    }

    // 지면 충돌: 수직 반발 + 접촉점 마찰(미끄럼/구름 전환, 백스핀 반영)
    function bounce() {
      const s = env.surface;
      const vn = -v[2];
      const e = Math.max(0.12, s.e0 - s.eK * vn);
      const Jn = BALL.m * (1 + e) * vn;
      const r = BALL.r;
      // 접촉점 속도 = v + ω × (0,0,-r)
      const u = [v[0] - r * w[1], v[1] + r * w[0]];
      const ul = Math.hypot(u[0], u[1]);
      v[2] = e * vn;
      if (ul < 1e-6) return;
      const keff = 1 / BALL.m + r * r / BALL.I;
      const Jt = Math.min(s.mu * Jn, ul / keff);
      const J = [-u[0] / ul * Jt, -u[1] / ul * Jt];
      v[0] += J[0] / BALL.m; v[1] += J[1] / BALL.m;
      w[0] += r * J[1] / BALL.I;
      w[1] += -r * J[0] / BALL.I;
      w[2] *= 0.7;
    }

    const fin = p;
    const lp = landing ? landing.p : fin;
    return {
      pts,
      apex,
      carry: Math.hypot(lp[0], lp[1]),
      carryY: lp[1], carryX: lp[0],
      total: Math.hypot(fin[0], fin[1]),
      totalY: fin[1], totalX: fin[0],
      flightTime: landing ? landing.t : t,
      landAngle: landing ? landing.angle : 0,
      landing: lp, final: fin,
    };
  }

  // 스핀 벡터 → 백스핀/사이드스핀/스핀축 표기
  function describeSpin(spin) {
    const [bx, ry, sz] = spin;
    const total = Math.hypot(bx, ry, sz);
    const axisTilt = Math.atan2(-sz, bx) * 180 / Math.PI; // +면 오른쪽으로 휨(페이드/슬라이스)
    return { back: bx, side: -sz, rifle: ry, total, axisTilt };
  }

  return { simulate, describeSpin, coeffs, BALL, RPM, SURFACES };
})();
if (typeof module !== 'undefined') module.exports = Golf;
