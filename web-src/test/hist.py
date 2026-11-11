import asyncio, json, time
from playwright.async_api import async_playwright
URL='file:///home/claude/dist/screengolf.html'
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--allow-file-access-from-files'])
    ctx=await b.new_context(viewport={'width':420,'height':900}); pg=await ctx.new_page()
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('dialog',lambda d:asyncio.ensure_future(d.accept()))
    await pg.goto(URL); await pg.wait_for_timeout(800)
    # 과거 기록 심기: 3일 전 1개, 6일 전 1개, 8일 전 1개(지워져야 함)
    now=time.time()*1000; D=86400000
    def mk(t,sp): return {'uid':t,'src':'카메라','L':{'speed':sp,'vla':14,'hla':1,'spin':[5000,0,-300]},'env':{'rho':1.2,'wind':[0,0,0],'surface':'fairway'},'extra':{'club':'iron7'},'time':t,'sum':{'carry':140,'total':150,'totalX':3,'apex':25,'flightTime':6,'carryX':2,'carryY':140,'totalY':150,'landAngle':40,'landing':[2,140,0],'final':[3,150,0]}}
    await pg.evaluate("d=>localStorage.setItem('psg-shots-v1',JSON.stringify(d))",[mk(now-3*D,45),mk(now-6*D+3600e3,46),mk(now-8*D,47)])
    await pg.reload(); await pg.wait_for_timeout(800)
    await pg.click('button[data-t=manual]')
    for i in range(2):
      await pg.click('#fire'); await pg.wait_for_timeout(300)
    await pg.reload(); await pg.wait_for_timeout(800)
    await pg.click('button[data-t=hist]')
    opts=await pg.eval_on_selector_all('#hDay option','e=>e.map(o=>o.textContent)')
    print('날짜 목록', opts)
    print('오늘 행', await pg.eval_on_selector_all('#hBody tr','e=>e.length'), await pg.text_content('#hSum'))
    stored=await pg.evaluate("JSON.parse(localStorage.getItem('psg-shots-v1')).length"); print('저장 개수', stored)
    # 3일 전 날짜 선택 후 행 클릭 → 궤적 다시 계산되는지
    v=await pg.eval_on_selector_all('#hDay option','e=>e.map(o=>o.value)')
    await pg.select_option('#hDay', v[1]); await pg.wait_for_timeout(200)
    await pg.click('#hBody tr'); await pg.wait_for_timeout(500)
    print('선택 샷 스탯', (await pg.text_content('#stats'))[:60])
    await pg.click('#hClear'); await pg.wait_for_timeout(300)
    print('지운 후 날짜', await pg.eval_on_selector_all('#hDay option','e=>e.map(o=>o.textContent)'), '저장', await pg.evaluate("JSON.parse(localStorage.getItem('psg-shots-v1')).length"))
    await pg.screenshot(path='/home/claude/test/hist.png')
    print('errors', errs)
    await b.close()
asyncio.run(main())
