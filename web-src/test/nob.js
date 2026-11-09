// 공이 없는 장면(방해물만) → 아무것도 고정하지 않아야 함
const S4=require('./synth4.js'); const D=require('../detector.js');
for (const flat of [false, true]) { const sc=S4.setup({rho:0.4, flatDisk: flat}); const det=new D.ShotDetector({camDist:0.4});
let locked=null; for(let i=0;i<40;i++){ const o=det.process({gray:new Uint8Array(sc.bg), w:sc.W, h:sc.H, t:i/1000}); if(o.state==='ready'){ locked=o.rest; break; } }
console.log('공 없음' + (flat?'+같은 크기 원판':''), locked ? `잘못 고정: ${locked.cx.toFixed(0)},${locked.cy.toFixed(0)} r${locked.r.toFixed(1)}` : '고정 안 함 ✓'); }
