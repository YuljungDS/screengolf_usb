// ===== 앱: 필드 렌더링 · 카메라/영상 입력 · 수동 샷 · 기록 =====
(() => {
  const $ = id => document.getElementById(id);
  const FIELD = { w: 100, l: 400 };
  const YD = 0.9144;

  // ---------- 설정 ----------
  const SKEYS = ['sNet', 'sDiag', 'sFov', 'sKf', 'sClub', 'sCamMode', 'sPhi', 'sPitch', 'sRoll', 'sCalM', 'sHand', 'sSpinMode', 'sDist', 'sDir', 'sThr', 'sDiff', 'sDepth', 'sProc', 'sTsFix', 'sCal', 'sDefSpin', 'sSurf', 'sWind', 'sWindDir', 'sAlt', 'sTemp', 'sUnit'];
  try { const saved = JSON.parse(localStorage.getItem('psg-settings') || '{}'); for (const k of SKEYS) if (saved[k] != null) $(k).value = saved[k]; } catch (e) { }
  const S = () => ({
    hand: $('sHand').value, spinMode: $('sSpinMode').value, club: $('sClub').value,
    useNet: $('sNet').value !== '0', diag: $('sDiag').value !== '0',
    fov: +$('sFov').value || 65, kf: +$('sKf').value || 0,
    camMode: $('sCamMode').value, phi: +$('sPhi').value || 0, pitch: +$('sPitch').value || 0, roll: +$('sRoll').value || 0, calM: $('sCalM').value,
    dist: +$('sDist').value || 1, dir: $('sDir').value, thr: +$('sThr').value || 0, diff: +$('sDiff').value || 30,
    depth: $('sDepth').value === '1', proc: +$('sProc').value, cal: +$('sCal').value || 1, defSpin: +$('sDefSpin').value || 0,
    surf: $('sSurf').value, wind: +$('sWind').value || 0, windDir: +$('sWindDir').value, alt: +$('sAlt').value || 0, temp: +$('sTemp').value, unit: $('sUnit').value,
  });
  for (const k of SKEYS) $(k).addEventListener('change', () => {
    try { const o = {}; for (const kk of SKEYS) o[kk] = $(kk).value; localStorage.setItem('psg-settings', JSON.stringify(o)); } catch (e) { }
    detOpts(); renderStats(); draw(); if ($('poseInfo')) $('poseInfo').textContent = poseText(); sizeInfo();
  });
  const dist = m => { const s = S(); return s.unit === 'yd' ? (m / YD) : m; };
  const du = () => S().unit === 'yd' ? 'yd' : 'm';

  function envOpts() {
    const s = S();
    const P = 101325 * Math.exp(-s.alt / 8434), T = s.temp + 273.15;
    const th = s.windDir * Math.PI / 180;
    return { rho: P / (287.05 * T), wind: [Math.sin(th) * s.wind, -Math.cos(th) * s.wind, 0], surface: s.surf };
  }

  // ---------- 칩/상태 ----------
  const chip = (txt, cls = '') => { const c = $('chip'); c.textContent = txt; c.className = cls; };

  // ---------- 탭 ----------
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'p-' + b.dataset.t));
  });

  // ---------- 샷 / 기록 ----------
  let shots = [], cur = null, anim = null;
  const estSpin = (speed, vla) => {
    const tab = [[0, 1500], [8, 2200], [11, 2600], [14, 4300], [17, 6800], [21, 8200], [26, 9300], [40, 9800]];
    let v = tab[tab.length - 1][1];
    for (let i = 1; i < tab.length; i++) if (vla <= tab[i][0]) { const [a, sa] = tab[i - 1], [b, sb] = tab[i]; v = sa + (sb - sa) * (Math.max(vla, a) - a) / (b - a); break; }
    if (speed < 15) v *= speed / 15; // 짧은 샷·퍼팅
    return v;
  };

  // ---------- 클럽 ----------
  const CLUBS = {
    driver: { name: '드라이버', spin: 2700, maxRpm: 6000 },
    wood3: { name: '3번 우드', spin: 3600, maxRpm: 7000 },
    iron7: { name: '7번 아이언', spin: 7000, maxRpm: 10000 },
    pw: { name: '피칭웨지', spin: 9000, maxRpm: 12000 },
  };
  // 자동: 티 위 공 → 드라이버, 지면에 놓인 공 → 7번 아이언
  const clubFor = onTee => { const c = S().club; return c === 'auto' ? (onTee ? 'driver' : 'iron7') : c; };

  // ---------- 기록 저장: 폰에 날짜별로 보관, 7일(오늘 포함) 지난 날짜는 자동 삭제 ----------
  const HIST_KEY = 'psg-shots-v1', KEEP_DAYS = 7;
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dayLabel = k => { const [y, m, d] = k.split('-').map(Number), w = '일월화수목금토'[new Date(y, m - 1, d).getDay()]; return `${m}월 ${d}일 (${w})${k === dayKey(Date.now()) ? ' · 오늘' : ''}`; };
  const oldestKeep = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (KEEP_DAYS - 1)); return d.getTime(); };
  // 궤적 점(pts)은 저장하지 않고 요약만 저장 → 그릴 때 처음 한 번 다시 계산
  function lazyRes(sum, L, env) {
    const r = Object.assign({}, sum);
    Object.defineProperty(r, 'pts', { configurable: true, enumerable: false, get() { const full = Golf.simulate(L, env); Object.defineProperty(r, 'pts', { value: full.pts }); return full.pts; } });
    return r;
  }
  function loadShots() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []; } catch (e) { arr = []; }
    const lim = oldestKeep();
    return arr.filter(o => o && o.time >= lim && o.L && o.sum).map(o => ({ uid: o.uid || o.time, src: o.src, L: o.L, env: o.env || {}, extra: o.extra || {}, time: o.time, day: dayKey(o.time), res: lazyRes(o.sum, o.L, o.env || {}) }));
  }
  function saveShots() {
    const lim = oldestKeep();
    shots = shots.filter(x => x.time >= lim || x.temp);
    const data = shots.filter(x => !x.temp).map(x => {
      const sum = {}; for (const k of Object.keys(x.res)) if (k !== 'pts') sum[k] = x.res[k];
      return { uid: x.uid, src: x.src, L: x.L, env: x.env, extra: x.extra, time: x.time, sum };
    });
    try { localStorage.setItem(HIST_KEY, JSON.stringify(data)); }
    catch (e) { chip('기록 저장 공간이 부족합니다 — 오래된 날짜를 지워 주세요', 'err'); }
  }
  shots = loadShots();
  let histDay = dayKey(Date.now());
  saveShots(); // 7일 지난 기록 정리

  function launch(L, src, extra = {}) {
    const env = envOpts();
    const res = Golf.simulate(L, env);
    const now = Date.now();
    const shot = { uid: now, src, L, env, res, extra, time: now, day: dayKey(now), temp: src === '데모' };
    if (shot.temp) shots = shots.filter(x => !x.temp); // 시작 화면 데모는 기록하지 않음
    shots.push(shot);
    if (!shot.temp) { histDay = shot.day; saveShots(); }
    cur = shot;
    renderStats(); renderHist();
    startAnim();
    if (src !== '데모' && navigator.vibrate) try { navigator.vibrate(30); } catch (e) { }
    return shot;
  }

  function fromDetector(sh, src) {
    const s = S();
    if (!sh.ok) { chip(sh.reason, 'err'); return; }
    let spin, spinNote;
    if (sh.spin && sh.spinFrom === 'texture') { spin = sh.spin; spinNote = `딤플/표면 무늬 · 신뢰도 ${(sh.spinConf * 100).toFixed(0)}% · ${sh.texPairs}쌍`; }
    else if (sh.spin) { spin = sh.spin; spinNote = `마커 ${sh.spinPairs}쌍`; }
    else {
      const club = CLUBS[clubFor(sh.onTee)];
      const b = s.defSpin > 0 ? s.defSpin : club.spin * Math.min(1.15, Math.max(0.5, estSpin(sh.speed * s.cal, sh.vla) / estSpin(club === CLUBS.driver ? 70 : 54, club === CLUBS.driver ? 11 : 16.3)));
      spin = [b, 0, 0];
      spinNote = '측정 실패 → 백스핀 추정·사이드 0 (구질은 출발 방향만 반영)';
      const fps = sh.frames > 1 && sh.dtTot > 0 ? (sh.frames - 1) / sh.dtTot : 0;
      if (fps) spinNote += ` · ${fps.toFixed(0)}fps에서는 약 ${(75 / 360 * 60 * fps).toFixed(0)}rpm 이하만 측정 가능`;
    }
    const L = { speed: sh.speed * s.cal, vla: sh.vla, hla: sh.hla, spin };
    const club = clubFor(sh.onTee);
    launch(L, src, { spinNote, frames: sh.frames, spinFrom: sh.spin ? sh.spinFrom : 'est', club, onTee: sh.onTee, posed: sh.posed });
    chip(`${src} 샷 · ${CLUBS[club].name}${S().club === 'auto' ? (sh.onTee ? '(티 감지)' : '(지면 공)') : ''} · ${sh.frames}프레임 · 스핀 ${spinNote}`, 'ok');
  }

  // ---------- 구질 판정 ----------
  // 출발 방향(방향각)과 휘는 정도(출발선 대비 낙하지점 좌우 차이 / 캐리)로 분류. 왼손잡이는 이름이 좌우 반대.
  function shotShape(shot) {
    const { L, res } = shot, right = S().hand !== 'L';
    const startDir = L.hla; // +: 오른쪽 출발
    const dev = res.carryX - res.carryY * Math.tan(L.hla * Math.PI / 180); // 출발선에서 낙하지점까지의 좌우 휨(m, +오른쪽)
    const pct = res.carry > 1 ? dev / res.carry * 100 : 0;
    const curveR = pct > 0; // 오른쪽으로 휨
    const mag = Math.abs(pct);
    // 오른손잡이 기준: 오른쪽으로 휘면 페이드/슬라이스, 왼쪽으로 휘면 드로우/훅
    const fadeSide = right ? curveR : !curveR;
    const curve = mag < 2.5 ? '' : mag < 7 ? (fadeSide ? '페이드' : '드로우') : (fadeSide ? '슬라이스' : '훅');
    const startOut = right ? startDir > 2.5 : startDir < -2.5;  // 바깥쪽(오른손: 오른쪽) 출발 = 푸시
    const startIn = right ? startDir < -2.5 : startDir > 2.5;   // 안쪽 출발 = 풀
    const start = startOut ? '푸시' : startIn ? '풀' : '';
    const name = start && curve ? `${start} ${curve}` : start || curve || '스트레이트';
    const color = curve.includes('슬라이스') || curve.includes('훅') ? '#ff8a6b' : curve ? '#ffd36b' : start ? '#9fd3ff' : '#5fd39a';
    const side = v => v >= 0 ? '오른쪽' : '왼쪽';
    const desc = `${Math.abs(startDir) < 0.5 ? '정면' : side(startDir) + ' ' + Math.abs(startDir).toFixed(1) + '°'} 출발 · ${mag < 0.5 ? '거의 휘지 않음' : side(dev) + '으로 ' + Math.abs(dev).toFixed(1) + 'm 휨'}`;
    return { name, color, desc, dev, pct };
  }

  const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
  function renderStats() {
    const el = $('stats');
    const L = cur?.L, r = cur?.res, sp = L ? Golf.describeSpin(L.spin) : null, U = du();
    const items = [
      ['볼 스피드', L ? fmt(L.speed) : '—', L ? 'm/s' : '', L ? `${fmt(L.speed * 2.23694, 0)} mph` : ''],
      ['발사각', L ? fmt(L.vla) : '—', '°'],
      ['방향각', L ? (L.hla >= 0 ? 'R ' : 'L ') + fmt(Math.abs(L.hla)) : '—', '°'],
      ['총 스핀', sp ? fmt(sp.total, 0) : '—', 'rpm'],
      ['백스핀 X', sp ? fmt(sp.back, 0) : '—', 'rpm'],
      ['사이드 Z', sp ? fmt(sp.side, 0) : '—', 'rpm'],
      ['라이플 Y', sp ? fmt(sp.rifle, 0) : '—', 'rpm'],
      ['스핀축', sp ? (sp.axisTilt >= 0 ? 'R ' : 'L ') + fmt(Math.abs(sp.axisTilt)) : '—', '°'],
      ['캐리', r ? fmt(dist(r.carry)) : '—', U],
      ['토탈', r ? fmt(dist(r.total)) : '—', U],
      ['최고 높이', r ? fmt(dist(r.apex)) : '—', U],
      ['좌우 편차', r ? (r.totalX >= 0 ? 'R ' : 'L ') + fmt(dist(Math.abs(r.totalX))) : '—', U],
    ];
    const shp = cur ? shotShape(cur) : null;
    $('shape').innerHTML = shp ? `<b style="color:${shp.color}">${shp.name}</b><span>${shp.desc}${sp ? ` · 스핀축 ${sp.axisTilt >= 0 ? '오른쪽' : '왼쪽'} ${Math.abs(sp.axisTilt).toFixed(1)}°` : ''}</span>` : '<span>구질: 샷을 기다리는 중</span>';
    el.innerHTML = items.map(([k, v, u, sub]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div>${sub ? `<div class="k">${sub}</div>` : ''}</div>`).join('');
    if (r) {
      const ob = isOB(r);
      if (!anim) { $('hudK').innerHTML = `캐리 · <b style="color:${shp.color}">${shp.name}</b>`; $('hudCarry').textContent = `${fmt(dist(r.carry))} ${U}`; }
      $('hudSub').innerHTML = `토탈 ${fmt(dist(r.total))} ${U} · 체공 ${fmt(r.flightTime)}s${ob ? ' · <span style="color:var(--bad)">OB</span>' : ''}<br><span class="k">${cur.extra.club ? CLUBS[cur.extra.club].name + ' · ' : ''}${cur.src}${cur.extra.spinNote ? ' · 스핀 ' + cur.extra.spinNote : ''}</span>`;
    }
  }
  const isOB = r => Math.abs(r.final[0]) > FIELD.w / 2 || r.final[1] > FIELD.l || r.final[1] < 0 || Math.abs(r.landing[0]) > FIELD.w / 2 || r.landing[1] > FIELD.l;

  const dayShots = k => shots.filter(x => !x.temp && x.day === k);
  function renderHist() {
    // 날짜 선택(최근 7일 중 기록 있는 날 + 오늘)
    const today = dayKey(Date.now());
    const days = [...new Set([today, ...shots.filter(x => !x.temp).map(x => x.day)])].sort().reverse();
    if (!days.includes(histDay)) histDay = today;
    $('hDay').innerHTML = days.map(k => `<option value="${k}"${k === histDay ? ' selected' : ''}>${dayLabel(k)} · ${dayShots(k).length}샷</option>`).join('');
    const list = dayShots(histDay);
    // 그날의 평균(캐리·토탈·속도)
    const avg = f => list.length ? list.reduce((a, x) => a + f(x), 0) / list.length : 0;
    $('hSum').textContent = list.length ? `${list.length}샷 · 평균 볼스피드 ${fmt(avg(x => x.L.speed))} m/s · 평균 캐리 ${fmt(dist(avg(x => x.res.carry)))}${du()} · 평균 토탈 ${fmt(dist(avg(x => x.res.total)))}${du()}` : '이 날 기록이 없습니다';
    $('hBody').innerHTML = list.map((s, i) => [s, i + 1]).reverse().map(([s, n]) => {
      const sp = Golf.describeSpin(s.L.spin);
      const tm = new Date(s.time), hm = `${String(tm.getHours()).padStart(2, '0')}:${String(tm.getMinutes()).padStart(2, '0')}`;
      return `<tr data-id="${s.uid}" class="${s === cur ? 'sel' : ''}"><td>${n}<br><span style="color:var(--mute);font-size:10px">${hm}</span></td><td>${s.src}${s.extra.club ? '<br>' + CLUBS[s.extra.club].name : ''}</td><td>${fmt(s.L.speed)}</td><td>${fmt(s.L.vla)}</td><td>${fmt(sp.back, 0)}/${fmt(sp.side, 0)}</td><td>${fmt(dist(s.res.carry))}</td><td>${fmt(dist(s.res.total))}${isOB(s.res) ? '<br><span style="color:var(--bad)">OB</span>' : ''}</td><td>${fmt(dist(s.res.totalX))}</td><td style="color:${shotShape(s).color}">${shotShape(s).name}</td></tr>`;
    }).join('');
    $('hBody').querySelectorAll('tr').forEach(tr => tr.onclick = () => { cur = shots.find(s => s.uid == tr.dataset.id); renderStats(); renderHist(); startAnim(); });
  }
  $('hDay').onchange = () => { histDay = $('hDay').value; renderHist(); draw(); };
  $('hClear').onclick = () => {
    const n = dayShots(histDay).length; if (!n) return;
    if (!confirm(`${dayLabel(histDay)} 기록 ${n}개를 지울까요? 되돌릴 수 없습니다.`)) return;
    shots = shots.filter(x => x.temp || x.day !== histDay);
    if (cur && !shots.includes(cur)) cur = null;
    saveShots(); renderStats(); renderHist(); draw();
  };
  $('hAll').onchange = () => draw();

  // ---------- 수동 샷 ----------
  const SL = [
    ['speed', '볼 스피드', 5, 90, 0.5, 'm/s'], ['vla', '발사각', -5, 60, 0.5, '°'], ['hla', '방향각', -20, 20, 0.5, '°'],
    ['back', '백스핀 X', -2000, 12000, 50, 'rpm'], ['side', '사이드 Z', -3000, 3000, 50, 'rpm'], ['rifle', '라이플 Y', -2000, 2000, 50, 'rpm'],
  ];
  const PRE = {
    driver: { speed: 70, vla: 11, hla: 0, back: 2600, side: 0, rifle: 0 },
    wood3: { speed: 63, vla: 9.5, hla: 0, back: 3600, side: 0, rifle: 0 },
    iron7: { speed: 53.6, vla: 16.3, hla: 0, back: 7000, side: 0, rifle: 0 },
    pw: { speed: 45, vla: 24, hla: 0, back: 9300, side: 0, rifle: 0 },
    slice: { speed: 66, vla: 13, hla: 2, back: 3200, side: 700, rifle: 0 },
    hook: { speed: 68, vla: 10, hla: -2, back: 2400, side: -600, rifle: 0 },
    topped: { speed: 40, vla: 2, hla: 0, back: 600, side: 0, rifle: 0 },
  };
  $('sliders').innerHTML = SL.map(([k, n, a, b, st, u]) => `<div class="sl"><span>${n}</span><input type="range" id="m-${k}" min="${a}" max="${b}" step="${st}"><output id="o-${k}"></output></div>`).join('');
  const setM = p => { for (const [k] of SL) { $('m-' + k).value = p[k]; } updM(); };
  const updM = () => { for (const [k, , , , , u] of SL) $('o-' + k).textContent = $('m-' + k).value + ' ' + u; };
  SL.forEach(([k]) => $('m-' + k).oninput = updM);
  document.querySelectorAll('.presets button').forEach(b => b.onclick = () => setM(PRE[b.dataset.p]));
  setM(PRE.driver);
  $('fire').onclick = () => {
    const g = k => +$('m-' + k).value;
    // 사이드 + = 오른쪽으로 휨 → ωz = -side
    launch({ speed: g('speed'), vla: g('vla'), hla: g('hla'), spin: [g('back'), g('rifle'), -g('side')] }, '수동');
    chip('수동 샷', 'ok');
  };

  // ---------- 3D 필드 렌더러 ----------
  const cv = $('field'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1, view = 'behind';
  function resize() {
    const r = cv.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    draw();
  }
  window.addEventListener('resize', resize);
  document.querySelectorAll('.views button').forEach(b => b.onclick = () => {
    view = b.dataset.v; document.querySelectorAll('.views button').forEach(x => x.classList.toggle('on', x === b)); draw();
  });

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // 카메라(시점) 구성: 원근(후방·추적) / 평행(상공·측면)
  let CAM;
  function setupCam(ballPos) {
    if (view === 'top') {
      const land = W > H * 1.3;
      const s = land ? Math.min(W / 430, H / 115) : Math.min(W / 115, H / 430);
      CAM = { ortho: true, f: p => land ? [W / 2 + (p[1] - 200) * s, H / 2 + p[0] * s, 1] : [W / 2 + p[0] * s, H / 2 - (p[1] - 200) * s, 1], s };
      return;
    }
    if (view === 'side') {
      const apex = Math.max(30, ...(cur ? [cur.res.apex] : [0]));
      const sh = W / 430, svv = Math.min(sh * 4, (H * 0.62) / apex);
      CAM = { ortho: true, side: true, ex: svv / sh, f: p => [12 + (p[1] + 10) * sh, H * 0.82 - p[2] * svv, 1], s: sh };
      return;
    }
    let eye, tgt, fov = 52;
    if (view === 'follow' && ballPos) {
      eye = [ballPos[0] * 0.7, ballPos[1] - 32, Math.max(5, ballPos[2] * 0.75 + 6)];
      tgt = [ballPos[0], ballPos[1] + 35, ballPos[2] * 0.6];
    } else { eye = [0, -32, 20]; tgt = [0, 175, 0]; }
    const fw = nrm(sub(tgt, eye)), rt = nrm(crs(fw, [0, 0, 1])), up = crs(rt, fw);
    const F = (H / 2) / Math.tan(fov * Math.PI / 360);
    CAM = { ortho: false, eye, fw, rt, up, F, toC: p => { const d = sub(p, eye); return [dot(d, rt), dot(d, up), dot(d, fw)]; } };
  }
  const NEAR = 0.3;
  const projC = c => [W / 2 + c[0] / c[2] * CAM.F, H / 2 - c[1] / c[2] * CAM.F];
  function P(p) { // 월드 → 화면 (가려지면 null)
    if (CAM.ortho) return CAM.f(p);
    const c = CAM.toC(p); if (c[2] < NEAR) return null; const s = projC(c); return [s[0], s[1], c[2]];
  }
  function poly(pts, fill, stroke) { // 근평면 클리핑
    let sp;
    if (CAM.ortho) sp = pts.map(CAM.f);
    else {
      const c = pts.map(CAM.toC), out = [];
      for (let i = 0; i < c.length; i++) {
        const a = c[i], b = c[(i + 1) % c.length];
        const ai = a[2] >= NEAR, bi = b[2] >= NEAR;
        if (ai) out.push(a);
        if (ai !== bi) { const t = (NEAR - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]); }
      }
      if (out.length < 3) return;
      sp = out.map(projC);
    }
    ctx.beginPath(); sp.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function line3(pts, style, width, dash) {
    ctx.strokeStyle = style; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false;
    if (CAM.ortho) { pts.forEach((p, i) => { const s = CAM.f(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); }); }
    else {
      let prev = null;
      for (const p of pts) {
        const c = CAM.toC(p);
        if (prev) {
          let a = prev, b = c;
          const ai = a[2] >= NEAR, bi = b[2] >= NEAR;
          if (ai || bi) {
            if (!ai) { const t = (NEAR - a[2]) / (b[2] - a[2]); a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]; pen = false; }
            if (!bi) { const t = (NEAR - a[2]) / (b[2] - a[2]); b = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]; }
            const sa = projC(a), sb = projC(b);
            if (!pen) { ctx.moveTo(sa[0], sa[1]); pen = true; }
            ctx.lineTo(sb[0], sb[1]);
            if (!bi) pen = false;
          } else pen = false;
        }
        prev = c;
      }
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  function label(p, txt, color = '#fff', size = 11, align = 'center', dy = 0) {
    const s0 = P(p); if (!s0) return null; const s = [s0[0], s0[1] + dy];
    ctx.font = `600 ${size}px system-ui,sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(txt, s[0], s[1]);
    ctx.fillStyle = color; ctx.fillText(txt, s[0], s[1]);
    return s;
  }

  function drawGround() {
    // 하늘
    if (!CAM.ortho || CAM.side) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#5b93c7'); g.addColorStop(0.55, '#a9cbe3'); g.addColorStop(1, '#d9e7ee');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else { ctx.fillStyle = '#2a4a28'; ctx.fillRect(0, 0, W, H); }
    if (CAM.side) {
      const gy = CAM.f([0, 0, 0])[1];
      ctx.fillStyle = '#3f7a37'; ctx.fillRect(0, gy, W, H - gy);
      const xl = CAM.f([0, FIELD.l, 0])[0];
      ctx.fillStyle = '#2d5a29'; ctx.fillRect(xl, gy, W - xl, H - gy);
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
      for (let y = 0; y <= FIELD.l; y += 50) { const s = CAM.f([0, y, 0]); ctx.beginPath(); ctx.moveTo(s[0], gy); ctx.lineTo(s[0], gy + 6); ctx.stroke(); label([0, y, -12 / (CAM.ex * CAM.s)], y ? `${Math.round(dist(y))}` : '0', '#fff', 10); }
      for (let z = 10; z <= 80; z += 10) { const s = CAM.f([0, -10, z]); if (s[1] < 10) break; ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, s[1], W, 1); ctx.fillStyle = 'rgba(20,40,60,.7)'; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`${Math.round(dist(z))}${du()}`, 2, s[1] - 5); }
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`높이 ${CAM.ex.toFixed(1)}배 확대 표시`, 8, H - 50);
      return;
    }
    // 러프(필드 바깥)
    poly([[-600, -120, 0], [600, -120, 0], [600, 1400, 0], [-600, 1400, 0]], '#2f5a2c');
    // 페어웨이 줄무늬
    for (let y = 0; y < FIELD.l; y += 20) poly([[-50, y, 0], [50, y, 0], [50, y + 20, 0], [-50, y + 20, 0]], (y / 20) % 2 ? '#4f9442' : '#5aa34b');
    // 티 박스
    poly([[-3, -3, 0], [3, -3, 0], [3, 1, 0], [-3, 1, 0]], '#79bf62');
    // OB 경계
    line3([[-50, 0, 0], [-50, FIELD.l, 0], [50, FIELD.l, 0], [50, 0, 0], [-50, 0, 0]], 'rgba(255,255,255,.95)', 2);
    // 거리선
    let lastY = Infinity;
    for (let y = 50; y <= FIELD.l; y += 50) {
      line3([[-50, y, 0], [50, y, 0]], 'rgba(255,255,255,.35)', 1);
      const t = S().unit === 'yd' ? `${Math.round(y / YD)}yd` : `${y}m`;
      const sp = P([-50, y, 0]);
      if (!sp || (!CAM.ortho && lastY - sp[1] < 13)) continue; // 원근으로 겹치는 먼 거리 표기는 생략
      lastY = sp[1];
      if (CAM.ortho) label([-51, y, 0], t, 'rgba(255,255,255,.85)', 10, 'right');
      else label([-50, y, 0], t, '#fff', 11, 'right');
    }
    line3([[0, 0, 0], [0, FIELD.l, 0]], 'rgba(255,255,255,.22)', 1, [6, 8]);
    // OB 말뚝
    if (!CAM.ortho) for (let y = 0; y <= FIELD.l; y += 25) for (const x of [-50, 50]) {
      const a = P([x, y, 0]), b = P([x, y, 1.2]); if (!a || !b) continue;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, 30 / a[2]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    if (CAM.ortho) { const a = P([0, 0, 0]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(a[0], a[1], 3, 0, 7); ctx.fill(); }
  }

  function pathUpTo(res, tt) {
    const pts = res.pts, out = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].t <= tt) out.push(pts[i].p);
      else { const a = pts[i - 1], b = pts[i]; if (a) { const k = (tt - a.t) / (b.t - a.t); out.push(a.p.map((v, j) => v + (b.p[j] - v) * k)); } break; }
    }
    return out;
  }

  function drawShot(shot, tt, main) {
    const res = shot.res;
    const path = pathUpTo(res, tt);
    if (path.length < 2) return path[0];
    const ground = path.map(p => [p[0], p[1], 0]);
    if (!CAM.side) line3(ground, main ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.12)', main ? 2 : 1);
    if (main && !CAM.side) {
      // 출발 방향선(점선): 이 선에서 얼마나 휘었는지로 구질을 판단
      const a = shot.L.hla * Math.PI / 180, Lc = res.carry * 1.05;
      line3([[0, 0, 0.05], [Math.sin(a) * Lc, Math.cos(a) * Lc, 0.05]], 'rgba(255,255,255,.55)', 1.2, [5, 6]);
    }
    line3(path, main ? '#ffe45c' : 'rgba(255,255,255,.45)', main ? 2.5 : 1.2);
    const last = path[path.length - 1];
    if (main) {
      if (tt >= res.flightTime) {
        // 낙하 지점
        const L = res.landing, ring = [];
        for (let a = 0; a <= 24; a++) ring.push([L[0] + Math.cos(a / 24 * 6.283) * 2.5, L[1] + Math.sin(a / 24 * 6.283) * 2.5, 0]);
        if (!CAM.side) line3(ring, '#ffe45c', 1.5);
        label([L[0], L[1], 0], `캐리 ${fmt(dist(res.carry))}`, '#ffe45c', 11, 'center', CAM.side ? -12 : 14);
      }
      const end = res.pts[res.pts.length - 1].t;
      if (tt >= end) {
        const F = res.final;
        if (!CAM.ortho) { const a = P(F), b = P([F[0], F[1], 4]); if (a && b) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.fillStyle = isOB(res) ? '#ff6b6b' : '#ffe45c'; ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] + 12, b[1] + 4); ctx.lineTo(b[0], b[1] + 8); ctx.fill(); } }
        label([F[0], F[1], CAM.ortho ? 0 : 5.5], `${fmt(dist(res.total))}${du()}${isOB(res) ? ' OB' : ''}`, isOB(res) ? '#ff8a8a' : '#fff', 12, 'center', CAM.side ? -28 : CAM.ortho ? -14 : -8);
      }
    }
    return last;
  }

  function draw(tt) {
    if (!W) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    let ballPos = null;
    if (cur) ballPos = pathUpTo(cur.res, tt ?? 1e9).slice(-1)[0];
    setupCam(ballPos);
    drawGround();
    if ($('hAll').checked) for (const s of (cur && !cur.temp ? dayShots(cur.day) : dayShots(histDay))) if (s !== cur) drawShot(s, 1e9, false);
    if (cur) {
      const last = drawShot(cur, tt ?? 1e9, true);
      if (last) {
        const s = P(last);
        if (s) {
          const rad = CAM.ortho ? 3.5 : Math.max(2.5, Math.min(8, 60 / s[2]));
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(s[0], s[1], rad, 0, 7); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  function startAnim() {
    if (anim) cancelAnimationFrame(anim.raf);
    if (!cur) return;
    const res = cur.res, end = res.pts[res.pts.length - 1].t;
    const t0 = performance.now();
    const step = now => {
      const real = (now - t0) / 1000;
      // 비행은 실시간, 구름은 2배속
      const tt = real <= res.flightTime ? real : res.flightTime + (real - res.flightTime) * 2.5;
      const path = pathUpTo(res, tt), p = path[path.length - 1];
      if (p) { $('hudK').textContent = tt < res.flightTime ? '비행 중' : '구르는 중'; $('hudCarry').textContent = `${fmt(dist(Math.hypot(p[0], p[1])))} ${du()}`; }
      draw(Math.min(tt, end));
      if (tt < end) anim.raf = requestAnimationFrame(step);
      else { anim = null; renderStats(); draw(); }
    };
    anim = { raf: requestAnimationFrame(step) };
  }
  $('replay').onclick = () => startAnim();

  // ---------- 공통: 프레임 → 그레이스케일 ----------
  function makeProc() {
    const c = document.createElement('canvas');
    const x = c.getContext('2d', { willReadFrequently: true });
    return {
      c, x,
      grab(src, sw, sh) {
        const pw = Math.min(S().proc, sw), ph = Math.round(sh * pw / sw);
        if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
        x.drawImage(src, 0, 0, pw, ph);
        const d = x.getImageData(0, 0, pw, ph).data, g = new Uint8Array(pw * ph);
        for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        return { gray: g, w: pw, h: ph };
      },
      put(gray, w, h) { // 네이티브에서 받은 그레이 프레임을 미리보기용 캔버스로
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.img = null; }
        if (!this.img) this.img = x.createImageData(w, h);
        const d = this.img.data;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) { const v = gray[i]; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
        x.putImageData(this.img, 0, 0);
      }
    };
  }
  function detOpts(det) {
    const s = S(), o = { camDist: s.dist, dir: s.dir, thr: s.thr, diffThr: s.diff, useDepth: s.depth, spinMode: s.spinMode, camM: camMatrix() };
    // 공 크기 조건: 탭으로 학습한 값이 있으면 그것(좁은 범위), 없으면 화각으로 추정(넓은 범위)
    o.kFocal = s.kf > 0 ? s.kf : 0.5 / Math.tan(s.fov * Math.PI / 360);
    o.useNet = s.useNet; o.netTemplates = templates.length ? templates : null; o.kLearned = s.kf > 0;
    o.sizeTol = s.kf > 0 ? [0.7, 1.45] : [0.4, 3.0];
    o.clubMax = s.club === 'auto' ? { tee: CLUBS.driver.maxRpm, ground: CLUBS.iron7.maxRpm } : { tee: CLUBS[s.club].maxRpm, ground: CLUBS[s.club].maxRpm };
    if (det) det.set(o); else { camDet?.set(o); vidDet?.set(o); }
    return o;
  }
  // 카메라 자세: 측면 자동(null) / 두 공 보정값 / 직접 입력(방위·숙임·기울기)
  function camMatrix() {
    const s = S();
    if (s.camMode === 'calib') { try { const M = JSON.parse(s.calM); if (Array.isArray(M) && M.length === 3) return M; } catch (e) { } return null; }
    if (s.camMode === 'manual') return Detector.camPose(s.phi, s.pitch, s.roll);
    return null;
  }
  function poseText() {
    const s = S();
    if (s.camMode === 'calib') { const M = camMatrix(); if (!M) return '보정값 없음 → 측면 자동'; const z = [M[0][2], M[1][2], M[2][2]]; return `보정됨: 방위 ${(Math.atan2(z[0], z[1]) * 180 / Math.PI).toFixed(0)}°, 숙임 ${(-Math.asin(z[2]) * 180 / Math.PI).toFixed(0)}°`; }
    if (s.camMode === 'manual') return `직접 입력: 방위 ${s.phi}°, 숙임 ${s.pitch}°, 기울기 ${s.roll}°`;
    return '측면 자동 (공이 화면 가로로 지나가는 위치)';
  }

  function overlay(cnv, proc, out, msgEl) {
    const c = cnv.getContext('2d');
    if (cnv.width !== proc.c.width || cnv.height !== proc.c.height) { cnv.width = proc.c.width; cnv.height = proc.c.height; }
    c.drawImage(proc.c, 0, 0);
    c.lineWidth = 2;
    if (out.cand && out.state === 'search') { c.strokeStyle = '#ffe45c'; c.beginPath(); c.arc(out.cand.cx, out.cand.cy, out.cand.r + 3, 0, 7); c.stroke(); }
    if (out.rest) { c.strokeStyle = out.state === 'ready' ? '#5fd39a' : 'rgba(95,211,154,.5)'; c.beginPath(); c.arc(out.rest.cx, out.rest.cy, out.rest.r + 4, 0, 7); c.stroke(); }
    for (const p of out.track || []) { c.strokeStyle = p.mk ? '#ff6b6b' : '#ffb454'; c.beginPath(); c.arc(p.u, p.v, p.r, 0, 7); c.stroke(); }
    const dd = (cnv.id === 'preview' ? camDet : vidDet);
    if (out.state === 'search' && dd && S().diag) { // 진단: 공 후보에서 탈락한 이유
      c.font = '10px sans-serif'; c.lineWidth = 1;
      for (const d of dd.diag || []) {
        if (d.r < 3 || d.r > cnv.height / 2) continue; // 화면 반 이상 크기(줄·바닥 등)는 표시 생략
        c.strokeStyle = 'rgba(255,107,107,.75)'; c.setLineDash([3, 3]); c.beginPath(); c.arc(d.cx, d.cy, d.r, 0, 7); c.stroke(); c.setLineDash([]);
        c.fillStyle = 'rgba(255,140,140,.95)'; c.fillText(d.why, d.cx - d.r, d.cy - d.r - 2);
      }
      if (out.cand && out.cand.net != null) { c.fillStyle = '#ffe45c'; c.fillText(`공 ${(out.cand.net * 100).toFixed(0)}%`, out.cand.cx + out.cand.r + 4, out.cand.cy); }
    }
    if (out.state === 'search' && camDet && camDet.rExp) { // 예상 공 크기 안내(왼쪽 아래 점선 원)
      const R = camDet.rExp, tl = camDet.o.sizeTol || [0.4, 3.0];
      c.setLineDash([4, 4]); c.strokeStyle = 'rgba(159,211,255,.9)'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(R * tl[1] + 6, cnv.height - R * tl[1] - 6, R, 0, 7); c.stroke(); c.setLineDash([]);
      c.fillStyle = 'rgba(159,211,255,.9)'; c.font = '11px sans-serif'; c.fillText('예상 공 크기', 4, cnv.height - R * tl[1] * 2 - 12);
    }
    if (CAL.on) for (const [k, p] of CAL.pts.entries()) { c.strokeStyle = '#9fd3ff'; c.lineWidth = 3; c.beginPath(); c.arc(p.cx, p.cy, p.r + 5, 0, 7); c.stroke(); c.fillStyle = '#9fd3ff'; c.font = 'bold 14px sans-serif'; c.fillText(k ? '② 타깃 방향' : '① 타격 위치', p.cx + p.r + 8, p.cy); }
    if (CAL.pts.length === 2) { c.strokeStyle = '#9fd3ff'; c.setLineDash([6, 5]); c.beginPath(); c.moveTo(CAL.pts[0].cx, CAL.pts[0].cy); c.lineTo(CAL.pts[1].cx, CAL.pts[1].cy); c.stroke(); c.setLineDash([]); }
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(0, 0, 150, 18); c.fillStyle = '#fff'; c.font = '11px monospace';
    c.fillText(`${out.state} thr=${out.thr | 0}`, 4, 13);
    if (msgEl) {
      let m = out.msg;
      if (out.state === 'ready' && out.rest) m += ` → ${CLUBS[clubFor(out.rest.onTee)].name}`;
      if (out.rest && out.rest.r < 30) m += ` · 공 지름 ${(out.rest.r * 2).toFixed(0)}px: 딤플 스핀에는 작습니다(60px 이상 권장 — 카메라를 가까이)`;
      msgEl.textContent = m;
    }
  }

  // ---------- 실시간 카메라 ----------
  let camStream = null, camDet = null, camProc = makeProc(), camRun = false, camVideo = null;
  const camWarn = t => { const w = $('camWarn'); w.style.display = t ? 'block' : 'none'; w.innerHTML = t || ''; };
  async function listCams() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const sel = $('camSel'), prev = sel.value;
      sel.innerHTML = (devs.length || NATIVE.port) ? '' : '<option value="">카메라 없음</option>';
      if (NATIVE.port) { const o = document.createElement('option'); o.value = '__uvc__'; o.textContent = '🔌 USB 카메라 (앱 내장 UVC 드라이버)'; sel.appendChild(o); }
      devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `카메라 ${i + 1}`; if (/usb|uvc|external|외부/i.test(d.label)) o.textContent += ' (USB)'; sel.appendChild(o); });
      if (prev) sel.value = prev;
      const usb = devs.find(d => /usb|uvc|external/i.test(d.label));
      if (usb && !prev) sel.value = usb.deviceId;
      if (NATIVE.port && (!prev || prev === '__uvc__')) sel.value = '__uvc__';
    } catch (e) { if (NATIVE.port) $('camSel').innerHTML = '<option value="__uvc__">🔌 USB 카메라 (앱 내장 UVC 드라이버)</option>'; }
    onCamSel();
  }
  $('camRefresh').onclick = () => { if (NATIVE.port) NATIVE.send({ cmd: 'list' }); listCams(); };
  const WEB_RES = $('camRes').innerHTML;
  function onCamSel() {
    const uvc = $('camSel').value === '__uvc__';
    $('camFps').style.display = uvc ? 'none' : ''; $('camFpsL').style.display = uvc ? 'none' : '';
    const want = uvc ? (NATIVE.sizes.length ? NATIVE.sizes.map(z => `<option value="${z}">${z.replace('x', '×')}</option>`).join('') : '<option value="640x480">640×480</option>') : WEB_RES;
    if ($('camRes').dataset.mode !== (uvc ? 'u' + want.length : 'w')) { const prev = $('camRes').value; $('camRes').innerHTML = want; $('camRes').dataset.mode = uvc ? 'u' + want.length : 'w'; if ([...$('camRes').options].some(o => o.value === prev)) $('camRes').value = prev; }
  }
  $('camSel').onchange = onCamSel;
  $('camStart').onclick = async () => {
    if (camRun) return stopCam();
    camWarn('');
    if ($('camSel').value === '__uvc__') return startNative();
    if (!navigator.mediaDevices?.getUserMedia) { camWarn('이 환경에서는 카메라를 쓸 수 없습니다. <b>HTTPS 주소</b>(또는 localhost)로 연 페이지에서만 카메라가 동작합니다. 미리보기 창 안에서는 카메라가 차단되니, 아래 안내대로 휴대폰 브라우저에서 직접 여세요.'); return; }
    const [w, h] = $('camRes').value.split('x').map(Number);
    const fps = +$('camFps').value;
    const id = $('camSel').value;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: id ? { exact: id } : undefined, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps } } });
    } catch (e) {
      let inFrame = false; try { inFrame = window.top !== window; } catch (x) { inFrame = true; }
      camWarn(`카메라를 열 수 없습니다: <b>${e.name}</b> ${e.message || ''}<br>${inFrame ? '· <b>지금은 미리보기 창 안이라 카메라가 차단됩니다.</b> HTML 파일을 HTTPS 주소로 올려 휴대폰 Chrome에서 직접 여세요.<br>' : ''}· 권한을 허용했는지 확인하세요.<br>· USB 카메라가 목록에 없다면, 이 휴대폰의 Android가 외부 USB 카메라를 브라우저에 노출하지 않는 경우입니다(제조사별 선택 기능). 이때는 <b>폰 스크린골프 안드로이드 앱</b>으로 열거나, <b>영상 분석</b> 탭(촬영한 영상)을 쓰세요.`);
      return;
    }
    await listCams();
    const tr = camStream.getVideoTracks()[0], st = tr.getSettings();
    $('camInfo').textContent = `${tr.label || '카메라'} · ${st.width}×${st.height} @ ${st.frameRate ? st.frameRate.toFixed(0) : '?'}fps 요청 결과`;
    if ((st.frameRate || 30) < 100) camWarn(`현재 <b>${(st.frameRate || 30).toFixed(0)} fps</b>입니다. 풀스윙 공(50 m/s 이상)은 한두 프레임 안에 화면을 지나가므로 속도·스핀 측정이 어렵습니다. <b>120 fps 이상(권장 240 fps+) 글로벌 셔터 USB 카메라</b>를 쓰거나, 짧은 칩·퍼팅으로 먼저 시험하세요.`);
    camDet = new Detector.ShotDetector({}); detOpts(camDet);
    camRun = true; $('camStart').textContent = '정지'; chip('카메라 실행 중', 'live');
    let lastT = -1, n = 0, tf = performance.now();
    const handle = (src, sw, sh, t) => {
      if (t <= lastT) return; lastT = t;
      const f = camProc.grab(src, sw, sh); f.t = t; camLast = f;
      if (CAL.on) { overlay($('preview'), camProc, { state: '보정', track: [], thr: 0, msg: CAL.msg }, $('camMsg')); return; }
      const out = camDet.process(f);
      learnSize(camDet);
      n++;
      if (n % 2 === 0 || out.state === 'track') overlay($('preview'), camProc, out, $('camMsg'));
      const now = performance.now();
      if (now - tf > 1000) { $('camInfo').textContent = `${tr.label || '카메라'} · ${f.w}×${f.h} 처리 · 실측 ${(n * 1000 / (now - tf)).toFixed(0)} fps`; n = 0; tf = now; }
      if (out.shot) fromDetector(out.shot, '카메라');
    };
    if ('MediaStreamTrackProcessor' in window) {
      // 모든 프레임을 화면 주사율과 무관하게 받음 (Chrome)
      const reader = new MediaStreamTrackProcessor({ track: tr }).readable.getReader();
      (async () => {
        while (camRun) {
          const { value: fr, done } = await reader.read(); if (done || !fr) break;
          try { handle(fr, fr.displayWidth, fr.displayHeight, fr.timestamp / 1e6); } finally { fr.close(); }
        }
      })();
    } else {
      camVideo = document.createElement('video'); camVideo.muted = true; camVideo.playsInline = true; camVideo.srcObject = camStream; await camVideo.play();
      const cb = (now, meta) => { if (!camRun) return; handle(camVideo, camVideo.videoWidth, camVideo.videoHeight, (meta.captureTime ?? meta.expectedDisplayTime ?? now) / 1000); camVideo.requestVideoFrameCallback(cb); };
      if (camVideo.requestVideoFrameCallback) camVideo.requestVideoFrameCallback(cb);
      else { const loop = () => { if (!camRun) return; handle(camVideo, camVideo.videoWidth, camVideo.videoHeight, performance.now() / 1000); requestAnimationFrame(loop); }; loop(); }
    }
  };
  function stopCam() { if (NATIVE.run) { NATIVE.send({ cmd: 'stop' }); NATIVE.run = false; } camRun = false; camStream?.getTracks().forEach(t => t.stop()); camStream = null; $('camStart').textContent = '카메라 시작'; chip('대기'); }
  $('camReset').onclick = () => { if (camDet) { camDet.seed = null; camDet.reset(); } };
  $('preview').addEventListener('click', e => {
    const r = e.target.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width * e.target.width, v = (e.clientY - r.top) / r.height * e.target.height;
    if (CAL.on) return calTap(u, v);
    if (!camDet) return;
    camDet.setSeed(u, v);
  });

  // ---------- '내 공' 템플릿(탭한 공 모습) ----------
  const TPL_KEY = 'psg-ball-templates';
  let templates = [];
  try { templates = (JSON.parse(localStorage.getItem(TPL_KEY) || '[]') || []).map(a => new Float32Array(a)); } catch (e) { templates = []; }
  function saveTemplates() { try { localStorage.setItem(TPL_KEY, JSON.stringify(templates.map(t => Array.from(t, v => +v.toFixed(3))))); } catch (e) { } }

  // ---------- 공 크기 학습 ----------
  // 화면에서 공을 탭해 고정하면 '초점거리/화면폭' 비율을 저장 → 이후 자동 탐색은 그 크기(±30~45%)의 둥근 물체만 공으로 봄
  function learnSize(det) {
    if (det && det.learnedTemplate) { // 탭한 공 모습을 '내 공' 템플릿으로 저장(최대 8개, 오래된 것부터 교체)
      templates.push(det.learnedTemplate); det.learnedTemplate = null;
      if (templates.length > 8) templates.shift();
      saveTemplates(); detOpts(); sizeInfo();
    }
    if (!det || !det.learnedK) return;
    const k = det.learnedK; det.learnedK = 0;
    if (!(k > 0.2 && k < 3)) return;
    $('sKf').value = k.toFixed(4); $('sKf').dispatchEvent(new Event('change'));
    $('camMsg').textContent = `공 크기를 학습했습니다 (거리 ${S().dist}m에서 지름 약 ${(k * (camLast?.w || 480) * 0.04267 / S().dist).toFixed(0)}px). 이제 비슷한 크기의 둥근 공만 찾습니다.`;
    sizeInfo();
  }
  function sizeInfo() {
    const s = S(), W = camLast?.w || s.proc, k = s.kf > 0 ? s.kf : 0.5 / Math.tan(s.fov * Math.PI / 360);
    const d = k * W * 0.04267 / s.dist, tol = s.kf > 0 ? [0.7, 1.45] : [0.55, 1.8];
    if ($('sizeInfo')) $('sizeInfo').textContent = `${s.kf > 0 ? '학습됨' : '화각 ' + s.fov + '° 추정'} · 거리 ${s.dist}m → 공 지름 약 ${d.toFixed(0)}px (허용 ${(d * tol[0]).toFixed(0)}~${(d * tol[1]).toFixed(0)}px) · 내 공 모습 ${templates.length}개 학습`;
  }
  $('sizeReset').onclick = () => { $('sKf').value = ''; templates = []; saveTemplates(); $('sKf').dispatchEvent(new Event('change')); sizeInfo(); };

  // ---------- 화면 저장(진단용) ----------
  // 지금 카메라 프레임(처리 해상도, 흑백 원본)을 PNG로 저장 → 대화창에 올려 주면 실제 영상으로 검출을 맞출 수 있음
  function frameToPNG(f) {
    const c = document.createElement('canvas'); c.width = f.w; c.height = f.h;
    const x = c.getContext('2d'), img = x.createImageData(f.w, f.h);
    for (let i = 0, j = 0; i < f.w * f.h; i++, j += 4) { img.data[j] = img.data[j + 1] = img.data[j + 2] = f.gray[i]; img.data[j + 3] = 255; }
    x.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  $('snapBtn').onclick = () => {
    const f = camLast; if (!f) { camWarn('카메라를 먼저 시작하세요.'); return; }
    const ts = new Date(), p = n => String(n).padStart(2, '0');
    const name = `screengolf_${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}_${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}_${f.w}x${f.h}.png`;
    const url = frameToPNG(f);
    if (NATIVE.port) { NATIVE.send({ cmd: 'save', name, data: url.split(',')[1] }); $('camMsg').textContent = '저장 중…'; return; }
    try { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); $('camMsg').textContent = `${name} 저장(다운로드)`; }
    catch (e) { $('camMsg').textContent = '이 화면에서는 저장할 수 없습니다(앱에서 사용하세요)'; }
  };

  // ---------- 카메라 각도 보정 (두 공) ----------
  // ① 타격 위치의 공, ② 타깃 방향으로 1~2m 앞에 놓은 공(둘 다 바닥에)을 차례로 탭 → 두 공의 3D 위치로 타깃 방향·카메라 숙임 계산
  let camLast = null;
  const CAL = { on: false, pts: [], msg: '' };
  function calStart() {
    if (!camRun || !camLast) { camWarn('카메라를 먼저 시작하세요.'); return; }
    CAL.on = true; CAL.pts = []; CAL.msg = '① 타격 위치(티 자리)에 놓은 공을 탭하세요';
    $('calBtn').textContent = '보정 취소'; $('camMsg').textContent = CAL.msg;
  }
  function calEnd(msg) { CAL.on = false; $('calBtn').textContent = '📐 카메라 각도 보정'; if (msg) $('camMsg').textContent = msg; if (camDet) { camDet.seed = null; camDet.reset(); } }
  function calTap(u, v) {
    const f = camLast; if (!f) return;
    // 탭한 곳 근처의 공을 정지 공 찾기와 같은 방식으로 정밀 검출
    const d = new Detector.ShotDetector({}); detOpts(d);
    d.setSeed(u, v);
    let ball = null;
    for (let k = 0; k < 2 && !ball; k++) { const o = d.process(f); ball = o.cand; }
    if (!ball) { CAL.msg = '그 위치에서 공을 찾지 못했습니다. 공 한가운데를 다시 탭하세요'; $('camMsg').textContent = CAL.msg; return; }
    CAL.pts.push({ cx: ball.cx, cy: ball.cy, r: ball.r, edge: !!ball.edge });
    if (CAL.pts.length === 1) { CAL.msg = '② 타깃 방향으로 1~2m 앞(같은 높이·바닥)에 놓은 두 번째 공을 탭하세요'; $('camMsg').textContent = CAL.msg; return; }
    // 두 공 3D 위치: 거리 설정(카메라↔① 공)으로 초점거리를 구하고, 공 크기로 깊이 계산
    const [a, b] = CAL.pts, s = S(), D0 = 0.04267, pu = f.w / 2, pv = f.h / 2;
    let fpx = 2 * a.r * s.dist / D0;
    for (let k = 0; k < 4; k++) { const q = Math.hypot(a.cx - pu, a.cy - pv) / fpx; fpx = 2 * a.r * s.dist / Math.sqrt(1 + q * q) / D0; }
    const P = p => { const Z = fpx * D0 / (2 * p.r); return [(p.cx - pu) / fpx * Z, (p.cy - pv) / fpx * Z, Z]; };
    const pose = Detector.poseFromTwo(P(a), P(b), s.pitch);
    $('sKf').value = (fpx / f.w).toFixed(4); $('sKf').dispatchEvent(new Event('change')); // ① 공으로 크기도 학습
    $('sCalM').value = JSON.stringify(pose.M.map(r => r.map(x => +x.toFixed(5))));
    $('sCamMode').value = 'calib';
    $('sCalM').dispatchEvent(new Event('change')); $('sCamMode').dispatchEvent(new Event('change'));
    CAL.pts = [];
    calEnd(`보정 완료 — 카메라 방위 ${pose.phi.toFixed(0)}° (−90=측면·0=후방), 숙임 ${pose.pitch.toFixed(0)}°. 두 번째 공을 치우고 시작하세요.`);
    $('poseInfo').textContent = poseText();
  sizeInfo();
  }
  $('calBtn').onclick = () => CAL.on ? calEnd('보정을 취소했습니다') : calStart();
  if (navigator.mediaDevices?.enumerateDevices) listCams();

  // ---------- 안드로이드 앱(USB/UVC 네이티브 드라이버) 브리지 ----------
  // 앱(ScreenGolf APK)이 USB 카메라를 직접 열고, 그레이 프레임을 WebMessagePort로 보내준다.
  // 프레임 형식(ArrayBuffer, little-endian): [u16 w][u16 h][i64 timestamp ns][w*h 바이트 Y(밝기)]
  const NATIVE = { port: null, run: false, sizes: [], ts: null, n: 0, tf: 0, info: '', send(o) { try { this.port?.postMessage(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) { } } };
  window.addEventListener('message', e => {
    if (e.data !== 'psg-native-init' || !e.ports || !e.ports[0]) return;
    NATIVE.port = e.ports[0];
    NATIVE.port.onmessage = ev => onNative(ev.data);
    $('camWarn').style.display = 'none';
    $('appBadge').style.display = 'inline';
    $('usbHint').style.display = 'none';
    NATIVE.send({ cmd: 'hello' }); NATIVE.send({ cmd: 'list' });
    listCams();
  });
  function b64ToBuf(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function onNative(d) {
    if (typeof d === 'string') {
      if (d.startsWith('b64:')) return nativeFrame(b64ToBuf(d.slice(4)));
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'saved') { $('camMsg').textContent = m.error ? `저장 실패: ${m.error}` : `저장했습니다: ${m.path} — 이 사진을 Claude 대화창에 올려 주세요`; return; }
      if (m.type === 'status') {
        if (Array.isArray(m.sizes) && m.sizes.length) { NATIVE.sizes = m.sizes; onCamSel(); }
        NATIVE.info = `${m.device || 'USB 카메라 없음'}${m.size ? ' · ' + m.size : ''}${m.fps ? ` · 수신 ${m.fps.toFixed(0)} fps` : ''}${m.drops ? ` · 버림 ${m.drops}` : ''}`;
        if (!NATIVE.run) $('camInfo').textContent = NATIVE.info;
        if (m.msg) $('camMsg').textContent = m.msg;
        if (m.state === 'error') { camWarn(m.msg); chip('USB 카메라 오류', 'err'); }
        if (m.state === 'closed' && NATIVE.run) { NATIVE.run = false; camRun = false; $('camStart').textContent = '카메라 시작'; chip('대기'); }
      }
      return;
    }
    if (d instanceof ArrayBuffer) nativeFrame(d);
  }
  function startNative() {
    const [w, h] = $('camRes').value.split('x').map(Number);
    camDet = new Detector.ShotDetector({}); detOpts(camDet);
    NATIVE.ts = null; NATIVE.n = 0; NATIVE.tf = performance.now();
    NATIVE.run = true; camRun = true;
    $('camStart').textContent = '정지'; chip('USB 카메라 연결 중', 'live');
    $('camMsg').textContent = 'USB 카메라 권한을 허용해 주세요…';
    NATIVE.send({ cmd: 'start', width: w || 640, height: h || 480, procW: S().proc });
  }
  // USB 전송 지터 보정: 프레임 간격을 추정해 균일한 시간축으로 재구성(누락 프레임은 간격 배수로 계산)
  function smoothT(tRaw) {
    const T = NATIVE.ts;
    if (!T) { NATIVE.ts = { last: tRaw, dt: 0, t: 0, warm: [] }; return 0; }
    const d = tRaw - T.last; T.last = tRaw;
    if (d <= 0) return T.t;
    if (T.warm.length < 15) { T.warm.push(d); const a = T.warm.slice().sort((p, q) => p - q); T.dt = a[a.length >> 1]; }
    else if (d > 0.6 * T.dt && d < 1.4 * T.dt) T.dt = T.dt * 0.99 + d * 0.01;
    T.t += Math.max(1, Math.round(d / T.dt)) * T.dt;
    return T.t;
  }
  function nativeFrame(buf) {
    NATIVE.send('ack');
    if (!NATIVE.run || !camDet) return;
    const dv = new DataView(buf), w = dv.getUint16(0, true), h = dv.getUint16(2, true);
    const tNs = Number(dv.getBigInt64(4, true));
    if (buf.byteLength < 12 + w * h) return;
    const gray = new Uint8Array(buf, 12, w * h);
    const t = $('sTsFix').value === '1' ? smoothT(tNs / 1e9) : tNs / 1e9;
    camLast = { gray, w, h, t };
    if (CAL.on) { camProc.put(gray, w, h); overlay($('preview'), camProc, { state: '보정', track: [], thr: 0, msg: CAL.msg }, $('camMsg')); return; }
    const out = camDet.process({ gray, w, h, t });
    learnSize(camDet);
    NATIVE.n++;
    if (NATIVE.n % 2 === 0 || out.state === 'track') { camProc.put(gray, w, h); overlay($('preview'), camProc, out, $('camMsg')); }
    const now = performance.now();
    if (now - NATIVE.tf > 1000) {
      const fps = NATIVE.n * 1000 / (now - NATIVE.tf); NATIVE.n = 0; NATIVE.tf = now;
      $('camInfo').textContent = `${NATIVE.info} · 처리 ${w}×${h} @ ${fps.toFixed(0)} fps${NATIVE.ts?.dt ? ` · 프레임간격 ${(NATIVE.ts.dt * 1000).toFixed(1)} ms` : ''}`;
      if (fps > 0 && chipEl().textContent.startsWith('USB 카메라 연결')) chip('USB 카메라 실행 중', 'live');
    }
    if (out.shot) fromDetector(out.shot, 'USB');
  }
  const chipEl = () => $('chip');

  // ---------- 영상 파일 분석 ----------
  let vidDet = null, vidProc = makeProc(), vEl = document.createElement('video');
  vEl.muted = true; vEl.playsInline = true; vEl.preload = 'auto';
  $('vfile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    vEl.src = URL.createObjectURL(f);
    vEl.onloadeddata = () => { $('vgo').disabled = false; $('vmsg').textContent = `${vEl.videoWidth}×${vEl.videoHeight}, ${vEl.duration.toFixed(2)}초`; vEl.currentTime = 0.001; };
    vEl.onseeked = () => { if (!vRun) { const fr = vidProc.grab(vEl, vEl.videoWidth, vEl.videoHeight); overlay($('vprev'), vidProc, { state: '미리보기', track: [], thr: 0, msg: '' }); } };
  };
  let vRun = false;
  $('vgo').onclick = async () => {
    if (vRun) { vRun = false; vEl.pause(); $('vgo').textContent = '분석 시작'; return; }
    if (!vEl.requestVideoFrameCallback) { $('vmsg').textContent = '이 브라우저는 프레임 단위 분석(requestVideoFrameCallback)을 지원하지 않습니다. 최신 Chrome/Safari를 쓰세요.'; return; }
    vidDet = new Detector.ShotDetector({}); detOpts(vidDet);
    vRun = true; $('vgo').textContent = '중지';
    const vfps = +$('vfps').value || 0;
    let lastMT = -1, minDt = Infinity, found = 0;
    vEl.pause(); vEl.currentTime = 0; vEl.playbackRate = +$('vrate').value;
    const cb = (now, meta) => {
      if (!vRun) return;
      const mt = meta.mediaTime;
      if (mt > lastMT) {
        if (lastMT >= 0) minDt = Math.min(minDt, mt - lastMT);
        lastMT = mt;
        // 실제 시간 = 파일 프레임 번호 / 촬영 fps (슬로모션 영상 보정)
        const t = (vfps > 0 && isFinite(minDt)) ? Math.round(mt / minDt) / vfps : mt;
        const f = vidProc.grab(vEl, vEl.videoWidth, vEl.videoHeight); f.t = t;
        const out = vidDet.process(f);
        overlay($('vprev'), vidProc, out, $('vmsg'));
        if (out.shot) { found++; fromDetector(out.shot, '영상'); }
        $('vbar').style.width = (100 * mt / vEl.duration).toFixed(1) + '%';
      }
      if (!vEl.ended) vEl.requestVideoFrameCallback(cb);
    };
    vEl.onended = () => { { const p = vidDet && vidDet.flush(); if (p) { found++; fromDetector(p, '영상'); } } vRun = false; $('vgo').textContent = '분석 시작'; $('vbar').style.width = '100%'; $('vmsg').textContent = found ? `완료 — 샷 ${found}개 검출` : `완료 — 샷을 찾지 못했습니다 (${vidDet.msg})`; };
    vEl.requestVideoFrameCallback(cb);
    try { await vEl.play(); } catch (e) { $('vmsg').textContent = '재생 실패: ' + e.message; vRun = false; }
  };

  // 카메라 위치 프리셋(직접 입력)
  document.querySelectorAll('[data-pose]').forEach(b => b.onclick = () => {
    const [phi, pitch] = b.dataset.pose.split(',').map(Number);
    $('sPhi').value = phi; $('sPitch').value = pitch; $('sRoll').value = 0; $('sCamMode').value = 'manual';
    $('sCamMode').dispatchEvent(new Event('change'));
  });
  $('poseInfo').textContent = poseText();

  // ---------- 시작 ----------
  renderStats(); renderHist();
  // 오늘 기록이 있으면 마지막 샷을 보여주고, 없으면 데모 샷
  requestAnimationFrame(() => {
    resize();
    const t = dayShots(dayKey(Date.now()));
    if (t.length) { cur = t[t.length - 1]; renderStats(); renderHist(); startAnim(); }
    else launch({ speed: 70, vla: 11, hla: 0, spin: [2600, 0, 0] }, '데모');
  });
})();
