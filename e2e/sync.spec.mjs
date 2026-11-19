import { chromium } from 'playwright'

// 超管凭据从环境变量读取，避免把密码写进仓库
const PB_ADMIN = process.env.PB_ADMIN_EMAIL || 'admin@example.com'
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || ''
import PocketBase from 'pocketbase'
const URL=process.env.PB_URL || 'http://127.0.0.1:8090', PB='http://127.0.0.1:8091'
const email = 'e2e' + Date.now() + '@test.local', password = 'e2e-pass-123456'
let failed = 0
const check = (ok, m) => { console.log((ok ? '  PASS ' : '  FAIL ') + m); if (!ok) failed++ }
const browser = await chromium.launch()
const SSE = ['data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mocked reply"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","title":"E2E Chat"}}',
  'data: {"type":"message_stop"}', '', ''].join('\n')
const mkPage = async () => {
  const ctx = await browser.newContext()
  await ctx.route('https://api.deepseek.com/**', (route) => {
    const u = route.request().url()
    if (u.includes('/models')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[{"id":"deepseek-flash"}]}' })
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: SSE })
  })
  return ctx.newPage()
}
const login = async (p, reg) => {
  await p.goto(URL)
  if (reg) await p.getByRole('tab', { name: '注册' }).click()
  await p.fill('#auth-email', email); await p.fill('#auth-password', password)
  if (reg) await p.fill('#auth-confirm', password)
  await p.getByRole('button', { name: reg ? '注册并进入' : '登录', exact: true }).click()
  await p.waitForSelector('#auth-password')
  await p.fill('#auth-password', password)
  await p.getByRole('button', { name: '解锁', exact: true }).click()
  await p.waitForSelector('textarea', { timeout: 25000 })
}
const A = await mkPage(); await login(A, true)
check(true, 'A 注册并解锁')
// 首次发送触发 API Key 设置弹窗
await A.getByRole('button', { name: '开启新对话' }).click(); await A.waitForTimeout(400)
await A.locator('textarea').first().click(); await A.keyboard.type('hello'); await A.keyboard.press('Enter')
const ki = A.getByPlaceholder('请输入 API Key'); await ki.waitFor({ timeout: 15000 })
await ki.fill('sk-e2e-fake-key-123456'); await ki.press('Enter'); await A.waitForTimeout(3500)
await A.keyboard.press('Escape'); await A.waitForTimeout(600)
check(true, '设置弹窗已弹出（API Key 缺失拦截）')
// 正式发送
const ta = A.locator('textarea').first()
await ta.click(); await A.keyboard.press('Control+A'); await A.keyboard.type('hello from device A')
await A.waitForTimeout(300); await A.keyboard.press('Enter')
await A.waitForTimeout(8000)
check(await A.evaluate(() => document.body.innerText.includes('hello from device A')), 'A 端消息可见')
const pb = new PocketBase(PB); await pb.collection('users').authWithPassword(email, password)
const sec = await pb.collection('secrets').getFullList()
const conv = await pb.collection('conversations').getFullList()
check(sec.length === 1, 'API Key 密文在服务端 (n=' + sec.length + ')')
check(!JSON.stringify(sec).includes('sk-e2e'), '服务端无 API Key 明文')
check(conv.length >= 1, '会话密文已上传 (n=' + conv.length + ')')
check(!JSON.stringify(conv).includes('hello from device A'), '服务端无聊天明文')
check(/^[A-Za-z0-9+/=]+$/.test(conv[0]?.cipher ?? ''), 'cipher 为 base64 不透明数据')
// 设备 B
const B = await mkPage(); await login(B, false)
await B.waitForTimeout(8000)
const bSessions = await B.evaluate(() => window.__ds_debug.get().sessions.map(s => s.title))
check(bSessions.length >= 1, 'B 端拉到会话列表 ' + JSON.stringify(bSessions))
await B.evaluate(() => { const el = Array.from(document.querySelectorAll('div')).find(d => d.innerText.trim() === '新对话'); el?.click() })
await B.waitForTimeout(2500)
check(await B.evaluate(() => document.body.innerText.includes('hello from device A')), 'B 端打开会话看到 A 的消息')
// 锁定 → 密钥清空
await A.getByRole('button', { name: '设置' }).first().click(); await A.waitForTimeout(900)
await A.getByRole('tab', { name: '数据管理' }).click(); await A.waitForTimeout(500)
await A.getByRole('button', { name: '锁定', exact: true }).click()
await A.waitForSelector('#auth-password', { timeout: 10000 })
check(true, '锁定后回到解锁页')
// 错误密码
await A.fill('#auth-password', 'wrong-password-zz'); await A.getByRole('button', { name: '解锁', exact: true }).click()
await A.waitForTimeout(7000)
check(/校验失败|无法/.test(await A.evaluate(() => document.body.innerText)), '错误密码被拒并提示')
// 正确密码
await A.fill('#auth-password', password); await A.getByRole('button', { name: '解锁', exact: true }).click()
await A.waitForSelector('textarea', { timeout: 25000 })
await A.waitForTimeout(2500)
check((await A.evaluate(() => window.__ds_debug.get().sessions.length)) >= 1, '重新解锁后历史仍在')
await browser.close()
console.log(failed === 0 ? '\nE2E PASSED' : '\nE2E FAILED: ' + failed)
process.exit(failed ? 1 : 0)