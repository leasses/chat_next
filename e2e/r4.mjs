import { chromium } from 'playwright'
const PB='http://127.0.0.1:8090'
const email='r4'+Date.now()+'@t.local', password='pass12345678'
let failed=0
const check=(ok,m)=>{console.log((ok?'  PASS ':'  FAIL ')+m); if(!ok)failed++}
const admin=await (await fetch(PB+'/api/admins/auth-with-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identity:'admin@example.com',password:'changeme123'})})).json()
const AH={Authorization:admin.token,'Content-Type':'application/json'}
const s=await (await fetch(PB+'/api/settings',{headers:AH})).json()
const crypto=await import('node:crypto')
const code='333333'
const hash=crypto.createHash('sha256').update(email+':'+code+':'+s.meta.appName).digest('hex')
await fetch(PB+'/api/collections/verifications/records',{method:'POST',headers:AH,body:JSON.stringify({email,code_hash:hash,expires:new Date(Date.now()+600000).toISOString(),used:false})})
await fetch(PB+'/api/collections/users/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,passwordConfirm:password,code})})
const u=await (await fetch(PB+'/api/collections/users/records?filter=(email=%27'+encodeURIComponent(email)+'%27)',{headers:AH})).json()
await fetch(PB+'/api/collections/users/records/'+u.items[0].id,{method:'PATCH',headers:AH,body:JSON.stringify({crypto_salt:crypto.randomBytes(32).toString('hex')})})
const browser=await chromium.launch()
const page=await (await browser.newPage({ viewport:{width:1280,height:800} }))
await page.goto(PB)
await page.fill('#auth-email',email); await page.fill('#auth-password',password)
await page.getByRole('button',{name:'登录',exact:true}).click()
await page.waitForSelector('#auth-password')
await page.fill('#auth-password',password); await page.getByRole('button',{name:'解锁',exact:true}).click()
await page.waitForSelector('textarea',{timeout:25000})
// 侧栏过渡应为 none
const trans=await page.evaluate(()=>getComputedStyle(document.querySelector('[class*=sider]')).transitionProperty)
check(!trans.includes('width'),'侧栏无宽度过渡（已回滚）')
// 收起后 DOM 中不应存在 sider
await page.getByRole('button',{name:'收起边栏'}).click(); await page.waitForTimeout(300)
const gone=await page.evaluate(()=>!document.querySelector('[class*=sider]'))
check(gone,'收起后侧栏从 DOM 移除（无动画）')
// 设置小按钮无 svg
await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.getAttribute('aria-label')?.includes('展开'));b?.click()})
await page.waitForTimeout(400)
await page.evaluate(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>x.innerText.trim()==='设置');b?.click()})
await page.waitForTimeout(900)
await page.getByRole('tab',{name:'数据管理'}).click(); await page.waitForTimeout(500)
const btns=await page.evaluate(()=>Array.from(document.querySelectorAll('button')).filter(b=>['锁定','退出登录','上传','下载'].includes(b.innerText.trim())).map(b=>({t:b.innerText.trim(),svg:b.querySelectorAll('svg').length})))
console.log('  小按钮:', JSON.stringify(btns))
check(btns.every(b=>b.svg===0),'设置里的小按钮已无图标')
// 通道选项图标应保留
const channelSvgs=await page.evaluate(()=>Array.from(document.querySelectorAll('[role=radio]')).filter(b=>['DeepSeek 官方','第三方网关'].includes(b.innerText.trim())).map(b=>b.querySelectorAll('svg').length))
check(channelSvgs.every(n=>n>0),'通道选项图标保留: '+JSON.stringify(channelSvgs))
await browser.close()
console.log(failed===0?'\nROLLBACK PASSED':'\nFAILED '+failed)