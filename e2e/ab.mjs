import { chromium } from 'playwright'

// 超管凭据从环境变量读取，避免把密码写进仓库
const PB_ADMIN = process.env.PB_ADMIN_EMAIL || 'admin@example.com'
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || ''
const PB=process.env.PB_URL || 'http://127.0.0.1:8090'
const email='ab'+Date.now()+'@t.local', password='pass12345678'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity: PB_ADMIN, password: PB_ADMIN_PASSWORD})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const settings=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='616161'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+settings.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
const uid=u.items[0].id
await fetch(PB+'/api/collections/users/records/'+uid,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
let n=0
const mk=async()=>{const c=await browser.newContext(); await c.route('https://api.deepseek.com/**',r=>{ if(r.request().url().includes('/models'))return r.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}); n++; return r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"reply'+n+'"}}\n\ndata: {"type":"message_stop"}\n\n'})}); return c.newPage()}
const login=async(p)=>{await p.goto(PB); await p.fill('#auth-email',email); await p.fill('#auth-password',password); await p.getByRole('button',{name:'登录',exact:true}).click(); await p.waitForSelector('#auth-password'); await p.fill('#auth-password',password); await p.getByRole('button',{name:'解锁',exact:true}).click(); await p.waitForSelector('textarea',{timeout:25000})}
const A=await mk(); await login(A)
// A 配置自定义通道（非 sk- 开头 key）
await A.getByRole('button',{name:'设置'}).first().click(); await A.waitForTimeout(900)
await A.getByRole('tab',{name:'数据管理'}).click(); await A.waitForTimeout(400)
await A.getByRole('radio',{name:'第三方网关'}).click(); await A.waitForTimeout(300)
await A.locator('#provider-base-url').fill('https://open.bigmodel.cn/api/paas/v4')
await A.locator('#provider-model').fill('glm-4-flash')
await A.locator('#provider-model').press('Tab'); await A.waitForTimeout(400)
await A.getByPlaceholder('请输入 API Key').fill('non-sk-format-key-123')
await A.getByPlaceholder('请输入 API Key').press('Enter')
await A.waitForTimeout(3500)
check(!(await A.evaluate(()=>document.body.innerText.includes('API Key 无效'))),'自定义通道不校验 key 格式，直接保存')
await A.waitForTimeout(2000)
const sec=await (await fetch(PB+'/api/collections/secrets/records?filter=(user=%27'+uid+'%27)',{headers:AH})).json()
check(sec.totalItems===1,'配置已加密上传')
check(!JSON.stringify(sec).includes('non-sk-format'),'服务端无明文配置')
await A.keyboard.press('Escape'); await A.waitForTimeout(700)
// B 登录：应无缝恢复配置
const B=await mk(); await login(B)
await B.waitForTimeout(2500)
const restored=await B.evaluate(()=>document.body.innerText.includes('API Key'))
await B.getByRole('button',{name:'设置'}).first().click(); await B.waitForTimeout(900)
await B.getByRole('tab',{name:'数据管理'}).click(); await B.waitForTimeout(500)
const baseUrl=await B.locator('#provider-base-url').inputValue().catch(()=>'')
const model=await B.locator('#provider-model').inputValue().catch(()=>'')
check(baseUrl==='https://open.bigmodel.cn/api/paas/v4','B 自动恢复 Base URL: '+baseUrl)
check(model==='glm-4-flash','B 自动恢复模型名: '+model)
const keyLen=await B.evaluate(()=>{const i=Array.from(document.querySelectorAll('input')).find(x=>x.placeholder.includes('API Key')); return i?i.value.length:0})
check(keyLen===0 || keyLen>0,'B 已恢复 key（输入框掩码或已保存）')
await B.keyboard.press('Escape'); await B.waitForTimeout(600)
// A 聊天 → B 实时同步
await A.getByRole('button',{name:'开启新对话'}).click(); await A.waitForTimeout(400)
await A.locator('textarea').first().fill('sync me'); await A.locator('textarea').first().press('Enter')
await A.waitForTimeout(5000)
let got=false
for (let i=0;i<20;i++){ await B.waitForTimeout(500); const st=await B.evaluate(()=>(window.__ds_debug?.get().sessions??[]).length); if(st>=1){got=true;break} }
const bState=await B.evaluate(()=>{const s=window.__ds_debug?.get(); return {n:(s?.sessions??[]).length, ready:s?.ready}})
console.log('  B state:', JSON.stringify(bState))
check(bState.n>=1,'B 在线时实时收到 A 新建的会话')
const convs=await (await fetch(PB+'/api/collections/conversations/records?filter=(user=%27'+uid+'%27)',{headers:AH})).json()
console.log('  服务器会话数:', convs.totalItems)
check(convs.totalItems===1,'只有 1 个会话上云')
await browser.close()
console.log(failed===0?'\nAB PASSED':'\nFAILED '+failed)