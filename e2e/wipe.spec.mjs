import { chromium } from 'playwright'

// 超管凭据从环境变量读取，避免把密码写进仓库
const PB_ADMIN = process.env.PB_ADMIN_EMAIL || 'admin@example.com'
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || ''
import PocketBase from 'pocketbase'
const URL=process.env.PB_URL || 'http://127.0.0.1:8090', PB='http://127.0.0.1:8091'
const email = 'wipe' + Date.now() + '@test.local', password = 'e2e-pass-123456'
let failed = 0
const check = (ok, m) => { console.log((ok ? '  PASS ' : '  FAIL ') + m); if (!ok) failed++ }
const browser = await chromium.launch()
const ctx = await browser.newContext()
await ctx.route('https://api.deepseek.com/**', r => r.request().url().includes('/models') ? r.fulfill({ status:200, contentType:'application/json', body:'{"data":[]}' }) : r.fulfill({ status:200, contentType:'text/event-stream', body: 'data: {"type":"message_stop"}\n\n' }))
const A = await ctx.newPage()
await A.goto(URL)
await A.getByRole('tab', { name: '注册' }).click()
await A.fill('#auth-email', email); await A.fill('#auth-password', password); await A.fill('#auth-confirm', password)
await A.getByRole('button', { name: '注册并进入' }).click()
await A.waitForSelector('#auth-password')
await A.fill('#auth-password', password); await A.getByRole('button', { name: '解锁', exact: true }).click()
await A.waitForSelector('textarea', { timeout: 25000 })
await A.getByRole('button', { name: '开启新对话' }).click(); await A.waitForTimeout(400)
await A.locator('textarea').first().click(); await A.keyboard.type('boot'); await A.keyboard.press('Enter')
const ki = A.getByPlaceholder('请输入 API Key'); await ki.waitFor({ timeout: 15000 }); await ki.fill('sk-wipe-test'); await ki.press('Enter'); await A.waitForTimeout(3500)
await A.keyboard.press('Escape'); await A.waitForTimeout(500)
const ta = A.locator('textarea').first(); await ta.click(); await A.keyboard.type('secret message'); await A.waitForTimeout(300); await A.keyboard.press('Enter')
await A.waitForTimeout(7000)
const pb = new PocketBase(PB); await pb.collection('users').authWithPassword(email, password)
const before = { conv: (await pb.collection('conversations').getFullList()).length, sec: (await pb.collection('secrets').getFullList()).length }
check(before.conv >= 1 && before.sec === 1, '重建前有密文: conv=' + before.conv + ' sec=' + before.sec)
const saltBefore = (await pb.collection('users').getOne(pb.authStore.record.id)).crypto_salt
// 打开设置 → 数据管理 → 清空加密数据并重置
await A.getByRole('button', { name: '设置' }).first().click(); await A.waitForTimeout(900)
await A.getByRole('tab', { name: '数据管理' }).click(); await A.waitForTimeout(500)
await A.getByRole('button', { name: '清空加密数据并重置' }).first().click()
await A.waitForTimeout(600)
await A.getByRole('button', { name: '清空并重置' }).click()
await A.waitForTimeout(6000)
const after = { conv: (await pb.collection('conversations').getFullList()).length, sec: (await pb.collection('secrets').getFullList()).length }
check(after.conv === 0 && after.sec === 0, '服务端密文已清空: conv=' + after.conv + ' sec=' + after.sec)
const saltAfter = (await pb.collection('users').getOne(pb.authStore.record.id)).crypto_salt
check(saltBefore !== saltAfter, 'salt 已更换（旧密钥无法再解密任何恢复的数据）')
check(await A.evaluate(() => !!document.querySelector('#auth-password')), '回到解锁页要求重新解锁')
await A.fill('#auth-password', password); await A.getByRole('button', { name: '解锁', exact: true }).click()
await A.waitForSelector('textarea', { timeout: 25000 }); await A.waitForTimeout(2500)
check((await A.evaluate(() => window.__ds_debug.get().sessions.length)) === 0, '重建后历史为空')
await browser.close()
console.log(failed === 0 ? '\nWIPE PASSED' : '\nWIPE FAILED: ' + failed)
process.exit(failed ? 1 : 0)