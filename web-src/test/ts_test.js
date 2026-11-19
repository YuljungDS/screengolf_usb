// smoothT 단독 시험: 시작 직후 띄엄띄엄(60ms) → 420fps, 처리 지연 흔들림 0~1.5ms, 가끔 버림
const src=require('fs').readFileSync('/home/claude/src/app.js','utf8');
const body=src.slice(src.indexOf('  function smoothT('), src.indexOf('  function nativeFrame(buf) {'));
for (const [fps, modeKnown, useSeq] of [[420,true,true],[420,true,false],[420,false,false],[120,true,true],[120,false,false]]) {
  const NATIVE={modeFps: modeKnown?fps:0, ts:null};
  const smoothT=new Function('NATIVE', body+'; return smoothT;')(NATIVE);
  let rng=7; const rnd=()=>(rng=(rng*1103515245+12345)&0x7fffffff)/0x7fffffff;
  const dt=1/fps; let errs=[], got=new Map();
  for (let k=0;k<3000;k++){
    const tTrue = k<10 ? k*0.06 : 0.6 + (k-10)*dt;
    if (k>10 && rnd()<0.1) continue; // 버림
    const tRaw = 100 + tTrue + 0.0005 + rnd()*0.0015;
    const libDrop = k>500 && k<520; if (libDrop) continue; // 라이브러리가 버린 프레임(번호도 안 셈)
    const seq = useSeq ? (k>=520 ? k-20 : k) : undefined;
    const t=smoothT(tRaw, seq); got.set(k,t);
    if (k>300 && got.has(k-20)) errs.push(Math.abs((t-got.get(k-20)) - 20*dt)*1000);
  }
  errs.sort((a,b)=>a-b);
  console.log(fps+'fps', modeKnown?'모드 fps 앎':'모름', useSeq?'프레임번호':'', '추정 간격', (NATIVE.ts.dt*1000).toFixed(2)+'ms', '20프레임 시간차 오차 중앙값', errs[errs.length>>1].toFixed(3)+'ms', '최대', errs[errs.length-1].toFixed(2)+'ms');
}
