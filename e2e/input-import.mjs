import { chromium, devices } from 'playwright'
const PB='http://127.0.0.1:8090'
const email='v4'+Date.now()+'@t.local', password='pass12345678'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity:'admin@example.com',password:'changeme123'})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const s=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='313131'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+s.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
await fetch(PB+'/api/collections/users/records/'+u.items[0].id,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
const ctx=await browser.newContext({ ...devices['Pixel 7'] })
await ctx.route('https://api.deepseek.com/**',r=>r.request().url().includes('/models')?r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}):r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n'}))
const page=await ctx.newPage()
await page.goto(PB)
await page.fill('#auth-email',email); await page.fill('#auth-password',password)
await page.getByRole('button',{name:'登录',exact:true}).click()
await page.waitForSelector('#auth-password')
await page.fill('#auth-password',password); await page.getByRole('button',{name:'解锁',exact:true}).click()
await page.waitForSelector('textarea',{timeout:25000})
// 导入按钮应直接触发文件选择（无链接输入框）
await page.locator('main button').first().click({force:true}).catch(()=>{})
await page.waitForTimeout(900)
await page.getByRole('button',{name:'设置'}).first().click({force:true}).catch(async()=>{await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='设置');b?.click()})})
await page.waitForTimeout(1000)
await page.getByRole('tab',{name:'数据管理'}).click(); await page.waitForTimeout(500)
const hasUrlInput=await page.locator('input[type=url]').count()
const hasFileInput=await page.locator('input[type=file][accept*=zip]').count()
check(hasUrlInput===0 && hasFileInput===1,'导入已回滚为直接选文件')
await page.keyboard.press('Escape'); await page.waitForTimeout(600)
// 回车换行
const ta=page.locator('textarea').first()
await ta.fill('line1')
await ta.press('Enter')
await ta.type('line2')
const val=await ta.inputValue()
check(val.includes('\n'),'回车插入换行而非发送')
await browser.close()
console.log(failed===0?'\nV4 PASSED':'\nFAILED '+failed)