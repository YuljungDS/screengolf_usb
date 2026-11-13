const T=require('./streak_test.js'); const fs=require('fs');
const W=640,H=360,{ref,render}=T; const GONE=new Uint8Array(fs.readFileSync('../real/range_noball.raw'));
const [v,vla,texp,trow]=[+process.argv[2],+process.argv[3],1/1000,20e-6]; const fps=120, tImp=40/fps+0.5/fps;
let rng=5; const rnd=()=>(rng=(rng*1103515245+12345)&0x7fffffff)/0x7fffffff;
const noisy=g=>Uint8Array.from(g,x=>Math.max(0,Math.min(255,x+Math.round((rnd()-0.5)*6))));
const out=[]; for(let k=0;k<110;k++){ const tau0=k/fps-tImp; out.push(Buffer.from(tau0<=-texp?noisy(ref):tau0>0.03?noisy(GONE):render({v,vla,texp,trow,tau0,club:true}))); }
fs.writeFileSync(process.argv[4], Buffer.concat(out).toString('base64'));
