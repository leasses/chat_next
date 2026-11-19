import { chromium } from 'playwright'

// 超管凭据从环境变量读取，避免把密码写进仓库
const PB_ADMIN = process.env.PB_ADMIN_EMAIL || 'admin@example.com'
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || ''
const PB=process.env.PB_URL || 'http://127.0.0.1:8090'
const email='inc'+Date.now()+'@t.local', password='pass12345678'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity: PB_ADMIN, password: PB_ADMIN_PASSWORD})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const settings=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='556677'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+settings.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
const uid=u.items[0].id
await fetch(PB+'/api/collections/users/records/'+uid,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
const ctx=await browser.newContext()
let n=0
await ctx.route('https://api.deepseek.com/**',r=>{ if(r.request().url().includes('/models'))return r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}); n++; return r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"reply-'+Date.now()+'-'+n+'"}}\n\ndata: {"type":"message_stop"}\n\n'})})
const page=await ctx.newPage()
await page.goto(PB)
await page.fill('#auth-email',email); await page.fill('#auth-password',password)
await page.getByRole('button',{name:'登录',exact:true}).click()
await page.waitForSelector('#auth-password')
await page.fill('#auth-password',password); await page.getByRole('button',{name:'解锁',exact:true}).click()
await page.waitForSelector('textarea',{timeout:25000})
// 先配 Key
await page.getByRole('button',{name:'开启新对话'}).click(); await page.waitForTimeout(400)
await page.locator('textarea').first().fill('setup'); await page.locator('textarea').first().press('Enter')
await page.getByPlaceholder('请输入 API Key').waitFor({timeout:12000})
await page.getByPlaceholder('请输入 API Key').fill('sk-test'); await page.getByPlaceholder('请输入 API Key').press('Enter')
await page.waitForTimeout(3500); await page.keyboard.press('Escape'); await page.waitForTimeout(700)
// 连发 4 条
for (let i=1;i<=4;i++) {
  await page.locator('textarea').first().fill('message number '+i+' with some content')
  await page.locator('textarea').first().press('Enter')
  await page.waitForTimeout(3500)
}
await page.waitForTimeout(3000)
const convs=await (await fetch(PB+'/api/collections/conversations/records?filter=(user=%27'+uid+'%27)',{headers:AH})).json()
const diffs=await (await fetch(PB+'/api/collections/diffs/records?perPage=50&filter=(user=%27'+uid+'%27)&sort=ts',{headers:AH})).json()
const full=convs.items[0]?.cipher.length ?? 0
const sizes=(diffs.items||[]).map(d=>d.diff.length)
console.log('全量密文:', full, '字节 | 增量条数:', diffs.totalItems)
console.log('每条增量:', JSON.stringify(sizes))
check(diffs.totalItems>=2, '产生了多条增量')
const tail=sizes.slice(1)
// 增量大小应接近「本轮新增内容」而非整段密文；
// 短会话里新消息占比本就大，因此用「增量 < 全量」+「多条消息只发几条增量」判断
check(tail.length>0 && tail.every(s=>s<full), '每轮增量都小于全量密文')
check(sizes.reduce((a,b)=>a+b,0) < full * sizes.length * 0.95, '增量总和小于逐次全量上传')
console.log('增量总和:', sizes.reduce((a,b)=>a+b,0), '字节 vs 若每次全量:', full*sizes.length)
await browser.close()
console.log(failed===0?'\nPASSED':'\nFAILED '+failed)