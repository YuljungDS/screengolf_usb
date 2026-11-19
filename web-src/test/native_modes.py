import asyncio
from playwright.async_api import async_playwright
JS = """
() => new Promise(res => {
  const ch = new MessageChannel(); const nat = ch.port1; const cmds=[];
  const modes=[{w:1280,h:800,type:7,fps:120,fpsList:[120,60,30]},{w:1280,h:720,type:7,fps:120,fpsList:[120,60]},{w:640,h:360,type:7,fps:420,fpsList:[420,210,120]},{w:640,h:400,type:7,fps:210,fpsList:[210,120]},{w:640,h:360,type:5,fps:30,fpsList:[30]},{w:1280,h:720,type:5,fps:10,fpsList:[10]}];
  nat.onmessage = e => { const d=e.data; if (d==='ack') return; const m=JSON.parse(d); cmds.push(m);
    if (m.cmd==='list'||m.cmd==='hello') nat.postMessage(JSON.stringify({type:'status',state:'idle',device:'OV9281 USB Camera',sizes:['1280x800','1280x720','640x360','640x400'],modes}));
    if (m.cmd==='start') nat.postMessage(JSON.stringify({type:'status',state:'open',device:'OV9281 USB Camera',size:'640x360',modeFps:420,modeType:'MJPEG',fps:398,sizes:[],modes,msg:'USB 카메라 열림 (640×360 · MJPEG · 카메라 설정 420fps)'}));
  };
  window.postMessage('psg-native-init','*',[ch.port2]);
  setTimeout(()=>{
    const opts=[...document.getElementById('camRes').options].map(o=>o.value+' = '+o.textContent);
    document.getElementById('camStart').click();
    setTimeout(()=>res({opts, start: cmds.filter(c=>c.cmd==='start'), info: document.getElementById('camInfo').textContent, msg: document.getElementById('camMsg').textContent, shutter: document.getElementById('sShutter').value, trow: document.getElementById('trowInfo').textContent}), 500);
  }, 500);
})
"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--allow-file-access-from-files'])
        pg=await b.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
        await pg.goto('file:///home/claude/dist/screengolf.html'); await pg.wait_for_timeout(500)
        r=await pg.evaluate(JS)
        for k,v in r.items(): print(k, v)
        print('errors', errs); await b.close()
asyncio.run(main())
