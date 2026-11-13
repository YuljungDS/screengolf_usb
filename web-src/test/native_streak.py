# 안드로이드 앱 쪽 동작을 흉내: MessageChannel로 init → start 명령 수신 → 240fps 합성 프레임(지터 포함) 전송
import asyncio
from playwright.async_api import async_playwright
import sys
NAME = sys.argv[1] if len(sys.argv)>1 else 'frames'
B64 = open(NAME+'.b64').read()
import base64 as _b, os as _o
if _o.environ.get('PAD'):  # 마지막 프레임을 이어 붙임(실제 카메라처럼 샷 뒤에도 프레임이 계속 들어오게)
    _r = _b.b64decode(B64); _fs = {'bw': 640*480, 'frames': 480*360}.get(NAME, 640*400)
    B64 = _b.b64encode(_r + _r[-_fs:] * int(_o.environ['PAD'])).decode()
WH = (640,360)
JS = """
([b64,W,H]) => new Promise(res => {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const N=raw.length/(W*H);
  const ch = new MessageChannel(); const nat = ch.port1; const log=[]; let acks=0, sent=0, inflight=0;
  nat.onmessage = e => {
    const d = e.data; log.push(typeof d==='string'? d.slice(0,60):'bin');
    if (d === 'ack') { acks++; inflight--; return; }
    const m = JSON.parse(d);
    if (m.cmd==='exposure') { log.push('EXP '+JSON.stringify(m)); nat.postMessage(JSON.stringify({type:'exposure',supported:true,mode:m.mode,time:m.mode==='manual'?0.001:0,asked:m.time,min:0.0001,max:0.3,gain:50})); return; }
    if (m.cmd==='list') nat.postMessage(JSON.stringify({type:'status',state:'idle',device:'FAKE UVC 240',sizes:['640x480','320x240']}));
    if (m.cmd==='start') {
      nat.postMessage(JSON.stringify({type:'status',state:'open',device:'FAKE UVC 240',size:'480x360',msg:'열림'}));
      let i=0; const t0=1e12; const dt=1e9/120;
      const tick = () => {
        if (i>=N) { res({log:log.filter(x=>x.startsWith('EXP')).concat(log.slice(0,4)), expInfo: document.getElementById('expInfo').textContent, acks, sent, info: document.getElementById('camInfo').textContent, msg: document.getElementById('camMsg').textContent}); return; }
        if (inflight>=3) { setTimeout(tick,1); return; }
        const buf = new ArrayBuffer(12+W*H), dv=new DataView(buf);
        dv.setUint16(0,W,true); dv.setUint16(2,H,true);
        const jitter = (Math.random()-0.5)*0.3e6; // ±0.6ms USB 지터
        dv.setBigInt64(4, BigInt(Math.round(t0 + i*dt + jitter)), true);
        new Uint8Array(buf,12).set(raw.subarray(i*W*H,(i+1)*W*H));
        nat.postMessage(buf,[buf]); sent++; inflight++; i++;
        setTimeout(tick, 9);
      };
      tick();
    }
  };
  window.postMessage('psg-native-init','*',[ch.port2]);
  setTimeout(()=>{ const e=document.getElementById('sExp'); e.value='0.001'; e.dispatchEvent(new Event('change')); const p=document.getElementById('sProc'); p.value='640'; p.dispatchEvent(new Event('change')); document.getElementById('camStart').click(); }, 300);
})
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        pg = await b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('file:///home/claude/dist/screengolf.html'); await pg.wait_for_timeout(500)
        if NAME!='frames':
            await pg.eval_on_selector('#sDist', "e=>{e.value='" + ('0.403' if NAME=='bw' else '0.52') + "'; e.dispatchEvent(new Event('change'))}")
        r = await pg.evaluate(JS, [B64, WH[0], WH[1]])
        print(r)
        print('sel:', await pg.eval_on_selector('#camSel','e=>e.value'), '| res opts:', await pg.eval_on_selector('#camRes','e=>[...e.options].map(o=>o.value).join(",")'))
        print('chip:', await pg.inner_text('#chip'))
        print('stats:', (await pg.inner_text('#stats')).replace('\n',' '))
        await pg.wait_for_timeout(2500); print('shape:', await pg.inner_text('#shape')); await pg.screenshot(path='n_'+NAME+'.png')
        print(errs or 'no errors'); await b.close()
asyncio.run(main())
