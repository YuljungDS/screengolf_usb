// 실제 스크린샷 프레임을 최신 검출기에 반복 입력 → 고정 결과·탈락 이유
const D=require(process.env.DET||'../src/detector.js'); const fs=require('fs');
const name=process.argv[2], W=640, H=360, g=new Uint8Array(fs.readFileSync(name+'.raw'));
const det=new D.ShotDetector(Object.assign({camDist:+(process.env.DIST||0.4)}, process.env.KF?{kFocal:+process.env.KF}:{}));
let o; for(let i=0;i<70;i++){ o=det.process({gray:g,w:W,h:H,t:i/120}); if(o.state==='ready') break; }
console.log(name, '상태', o.state, o.rest?`고정 ${o.rest.cx.toFixed(0)},${o.rest.cy.toFixed(0)} r${o.rest.r.toFixed(1)}`:'', '| 예상 r', det.rExp&&det.rExp.toFixed(1), det.tolNow);
console.log(' 후보', o.cand?`${o.cand.cx.toFixed(0)},${o.cand.cy.toFixed(0)} r${o.cand.r.toFixed(1)} net ${o.cand.net?.toFixed(3)} score ${o.cand.score?.toFixed(3)}`:'-');
console.log(' 탈락', JSON.stringify((det.diag||[]).map(d=>[Math.round(d.cx),Math.round(d.cy),+d.r.toFixed(1),d.why])));
