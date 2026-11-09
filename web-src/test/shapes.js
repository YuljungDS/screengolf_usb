// 도형별 원형도(인라이어 비율)·입체감 점검
const D=require('../detector.js'); const W=320,H=240;
function img(fn){ const g=new Uint8Array(W*H); for(let y=0;y<H;y++)for(let x=0;x<W;x++){ g[y*W+x]=fn(x,y)?230:60+((x*7+y*3)%9);} return {gray:g,w:W,h:H,t:0}; }
const det=new D.ShotDetector({camDist:0.4});
const T={
 '정사각형 50': (x,y)=>Math.abs(x-160)<25&&Math.abs(y-120)<25,
 '직사각형 64x40': (x,y)=>Math.abs(x-160)<32&&Math.abs(y-120)<20,
 '기운 정사각형': (x,y)=>{const u=(x-160)*0.8+(y-120)*0.6,v=-(x-160)*0.6+(y-120)*0.8;return Math.abs(u)<25&&Math.abs(v)<25;},
 '타원 1.3:1': (x,y)=>((x-160)/32)**2+((y-120)/25)**2<1,
 '육각형': (x,y)=>{const a=Math.atan2(y-120,x-160), r=Math.hypot(x-160,y-120); const k=Math.PI/3; const aa=((a%k)+k)%k - k/2; return r*Math.cos(aa) < 26;},
 '원(평평)': (x,y)=>(x-160)**2+(y-120)**2<27*27,
};
for(const [k,fn] of Object.entries(T)){ const v=det.verify(img(fn),{cx:160,cy:120,r:28}); console.log(k.padEnd(12),'원 위 비율',v.inlier.toFixed(2),'튀어나옴',v.protrude.toFixed(2),'호',v.arc.toFixed(2),'입체감',v.shade.toFixed(3), (v.inlier>=0.5 && v.protrude<=0.2 && (v.inlier>=0.9||v.arc>=0.75))?(v.shade<0.035?'→ 평평해서 제외':'→ 통과'):'→ 원 아님 제외'); }
