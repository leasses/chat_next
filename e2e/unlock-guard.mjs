import { chromium } from 'playwright'
const PB=process.env.PB_URL || 'http://127.0.0.1:8090'
const email='v2'+Date.now()+'@t.local', password='pass12345678'
const WRONG='wrong-password-zz'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity:'admin@example.com',password:'changeme123'})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const s=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='131313'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+s.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
const uid=u.items[0].id
await fetch(PB+'/api/collections/users/records/'+uid,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
const ctx=await browser.newContext()
await ctx.route('https://api.deepseek.com/**',r=>r.request().url().includes('/models')?r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}):r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n'}))
const page=await ctx.newPage();
// 注册并解锁
await page.goto(PB)
await page.getByRole('tab',{name:'注册'}).click()
await page.fill('#auth-email',email); await page.fill('#auth-password',password); await page.fill('#auth-confirm',password)
// 注册需要验证码：直接插入后再填
await page.fill('#auth-code',code).catch(()=>{})
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})}).catch(()=>{})
await page.getByRole('button',{name:'注册并进入'}).click().catch(()=>{})
await page.waitForTimeout(1500)
// 直接登录（前面已用后台建号）
await page.goto(PB)
await page.fill('#auth-email',email); await page.fill('#auth-password',password)
await page.getByRole('button',{name:'登录',exact:true}).click()
await page.waitForSelector('#auth-password')
await page.fill('#auth-password',password); await page.getByRole('button',{name:'解锁',exact:true}).click()
await page.waitForSelector('textarea',{timeout:25000})
check(true,'正常密码解锁成功')
// 配 Key + 发一条消息，建立基线
await page.getByRole('button',{name:'设置'}).first().click(); await page.waitForTimeout(900)
await page.getByRole('tab',{name:'数据管理'}).click(); await page.waitForTimeout(400)
await page.getByPlaceholder('请输入 API Key').fill('sk-test'); await page.getByPlaceholder('请输入 API Key').press('Enter')
await page.waitForTimeout(3000); await page.keyboard.press('Escape'); await page.waitForTimeout(700)
await page.getByRole('button',{name:'开启新对话'}).click(); await page.waitForTimeout(400)
await page.locator('textarea').first().fill('hello v2'); await page.locator('textarea').first().press('Enter')
await page.waitForTimeout(6000)
const convs1=await (await fetch(PB+'/api/collections/conversations/records?filter=(user=%27'+uid+'%27)',{headers:AH})).json()
check(convs1.totalItems>=1,'会话已上传')
// 关键：刷新后用错误密码登录
await page.reload(); await page.waitForTimeout(2000)
const hasUnlock=await page.locator('#auth-password').count()
if(hasUnlock){
  await page.fill('#auth-password',WRONG)
  await page.getByRole('button',{name:'解锁',exact:true}).click()
  await page.waitForTimeout(4000)
  const stillLocked=await page.locator('#auth-password').count()>0
  const errText=await page.evaluate(()=>document.body.innerText)
  check(stillLocked,'刷新后错误密码无法进入')
} else { await page.fill('#auth-email',email); await page.fill('#auth-password',WRONG); await page.getByRole('button',{name:'登录',exact:true}).click(); await page.waitForTimeout(3000); check(await page.locator('#auth-email').count()>0,'错误密码被拒绝') }
await browser.close()
console.log(failed===0?'\nV2 PASSED':'\nFAILED '+failed)