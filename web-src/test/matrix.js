const D=require('../src/detector.js');const fs=require('fs');
const T={box:[431,223,48],box_clean:[431,223,48],led:[421,264,40],box_clean_adv:[431,223,48],led_adv:[421,264,40],noball:null};
let bad=0;
for (const n of Object.keys(T)) { const g=new Uint8Array(fs.readFileSync(n+'.raw'));
 for (const dist of [0.3,0.4,0.5]) for (const fov of [50,65,80]) { const det=new D.ShotDetector({camDist:dist,kFocal:0.5/Math.tan(fov*Math.PI/360)}); let o,t0=Date.now(),k=0;
  for(let i=0;i<90;i++){o=det.process({gray:g,w:640,h:360,t:i/120});k++; if(o.state==='ready')break;}
  const t=T[n]; const ok = t ? (o.rest && Math.hypot(o.rest.cx-t[0],o.rest.cy-t[1])<t[2]*0.2) : o.state!=='ready';
  if(!ok) bad++;
  console.log(ok?'✓':'✗', n.padEnd(14),'dist',dist,'fov',fov,o.state,o.rest?o.rest.cx.toFixed(0)+','+o.rest.cy.toFixed(0)+' r'+o.rest.r.toFixed(0)+' net '+(o.rest.net??-1).toFixed(2):'', ((Date.now()-t0)/k).toFixed(0)+'ms'); } }
console.log('실패', bad);
