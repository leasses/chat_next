import { chromium } from 'playwright'

// 超管凭据从环境变量读取，避免把密码写进仓库
const PB_ADMIN = process.env.PB_ADMIN_EMAIL || 'admin@example.com'
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || ''
const PB=process.env.PB_URL || 'http://127.0.0.1:8090'
const email='rt6'+Date.now()+'@t.local', password='pass12345678'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity: PB_ADMIN, password: PB_ADMIN_PASSWORD})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const settings=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='424242'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+settings.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
const uid=u.items[0].id
await fetch(PB+'/api/collections/users/records/'+uid,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
let n=0
const mk=async(tag)=>{const c=await browser.newContext(); await c.route('https://api.deepseek.com/**',r=>{ if(r.request().url().includes('/models'))return r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}); n++; return r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"r'+n+'"}}\n\ndata: {"type":"message_stop"}\n\n'})}); const p=await c.newPage(); p.on('console',m=>{const t=m.text(); if(/\[RT\]|\[AD\]|realtime/.test(t))console.log('  '+tag+'|',t.slice(0,130))}); return p}
const login=async(p)=>{await p.goto(PB); await p.fill('#auth-email',email); await p.fill('#auth-password',password); await p.getByRole('button',{name:'登录',exact:true}).click(); await p.waitForSelector('#auth-password'); await p.fill('#auth-password',password); await p.getByRole('button',{name:'解锁',exact:true}).click(); await p.waitForSelector('textarea',{timeout:25000})}
const A=await mk('A'); await login(A)
await A.getByRole('button',{name:'设置'}).first().click(); await A.waitForTimeout(900)
await A.getByRole('tab',{name:'数据管理'}).click(); await A.waitForTimeout(400)
await A.getByPlaceholder('请输入 API Key').fill('sk-test'); await A.getByPlaceholder('请输入 API Key').press('Enter')
await A.waitForTimeout(3000); await A.keyboard.press('Escape'); await A.waitForTimeout(700)
await A.getByRole('button',{name:'开启新对话'}).click(); await A.waitForTimeout(500)
await A.locator('textarea').first().fill('baseline message'); await A.locator('textarea').first().press('Enter')
await A.waitForTimeout(4500)
// B 上线并打开会话
const B=await mk('B'); await login(B); await B.waitForTimeout(2500)
await B.evaluate(()=>{const el=Array.from(document.querySelectorAll('div')).find(d=>d.innerText.trim()==='新对话'); el?.click()}); await B.waitForTimeout(1500)
const before=await B.evaluate(()=>document.body.innerText.includes('LIVE MARKER'))
check(!before,'B 打开会话，尚无新消息')
const t0=Date.now()
await A.locator('textarea').first().fill('LIVE MARKER from A'); await A.locator('textarea').first().press('Enter')
let seen=false, ms=0
for(let i=0;i<60;i++){ await B.waitForTimeout(100); if(await B.evaluate(()=>document.body.innerText.includes('LIVE MARKER'))){seen=true;ms=Date.now()-t0;break} }
console.log('  到达耗时:',ms,'ms')
check(seen,'B 收到新消息')
check(ms<3000,'实时推送 (<3s) 而非轮询')
await browser.close()
console.log(failed===0?'\nREALTIME PASSED':'\nFAILED '+failed)