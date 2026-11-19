// PocketBase JS hook：注册前校验邮箱验证码。
//
// 注意：PB 的 goja 每个回调独立编译，文件顶层的函数/常量在 handler 内不可见，
// 因此所有逻辑都写在对应回调内部，跨回调只通过数据库传递状态。
//
//   POST /api/verify/request  { email } -> 生成 6 位码，写 verifications，发信
//   POST /api/collections/users/records { email, password, passwordConfirm, code } -> 校验后建号

/// <reference path="../pb_data/types.d.ts" />

routerAdd('POST', '/api/verify/request', (c) => {
  const CODE_TTL = 10 * 60 * 1000
  const RESEND_INTERVAL = 60 * 1000
  const DAILY_LIMIT = 10
  const IP_HOURLY_LIMIT = 20

  const data = $apis.requestInfo(c).data
  const email = String(data.email || '').trim().toLowerCase()
  if (!email || email.indexOf('@') < 0) {
    throw new BadRequestError('邮箱格式不正确')
  }

  const now = Date.now()
  const dao = $app.dao()

  const recent = dao.findRecordsByFilter('verifications', 'email = {:email}', '-created', 1, 0, { email })
  if (recent.length > 0) {
    const last = new Date(recent[0].getString('created')).getTime()
    if (now - last < RESEND_INTERVAL) {
      throw new BadRequestError('请求过于频繁，请稍后再试')
    }
    const today = dao.findRecordsByFilter(
      'verifications',
      'email = {:email} && created > {:since}',
      '',
      1000,
      0,
      { email, since: new Date(now - 86400000).toISOString() }
    )
    if (today.length >= DAILY_LIMIT) {
      throw new BadRequestError('今日验证码次数已达上限')
    }
  }

  const ip = c.realIP()
  if (ip) {
    const hourly = dao.findRecordsByFilter(
      'verifications',
      'ip = {:ip} && created > {:since}',
      '',
      1000,
      0,
      { ip, since: new Date(now - 3600000).toISOString() }
    )
    if (hourly.length >= IP_HOURLY_LIMIT) {
      throw new BadRequestError('请求过于频繁，请稍后再试')
    }
  }

  // 6 位数字：从 PB 的加密安全随机串里取数字字符
  const raw = $security.randomString(24)
  let code = ''
  for (let i = 0; i < raw.length && code.length < 6; i++) {
    const ch = raw.charCodeAt(i)
    if (ch >= 48 && ch <= 57) code += raw[i]
  }
  while (code.length < 6) {
    code += String(Math.floor(Math.random() * 10))
  }

  const hash = $security.sha256(email + ':' + code + ':' + $app.settings().meta.appName)

  const rec = new Record(dao.findCollectionByNameOrId('verifications'))
  rec.set('email', email)
  rec.set('code_hash', hash)
  rec.set('expires', new Date(now + CODE_TTL).toISOString())
  rec.set('used', false)
  if (ip) rec.set('ip', ip)
  dao.saveRecord(rec)

  try {
    const settings = $app.settings()
    const message = new MailerMessage({
      from: { address: settings.meta.senderAddress, name: settings.meta.senderName },
      to: [{ address: email }],
      subject: 'Chat Demo 验证码',
      text: '你的验证码是 ' + code + '，10 分钟内有效。\n\n如果不是你本人操作，请忽略本邮件。',
      html: '<p>你的验证码是 <b style="font-size:22px;letter-spacing:4px">' + code + '</b></p><p>10 分钟内有效。如果不是你本人操作，请忽略本邮件。</p>',
    })
    $app.newMailClient().send(message)
  } catch (err) {
    dao.deleteRecord(rec) // 发信失败不留记录，允许立即重试
    throw new ApiError(500, '验证码发送失败，请检查服务器邮件配置')
  }

  return c.json(200, { ok: true })
}, $apis.requireGuestOnly())

// 注册：校验验证码后摘掉该字段
onRecordBeforeCreateRequest((e) => {
  if (e.collection.name !== 'users') return
  // 仅拦截匿名注册；后台（管理员 token）建号不带验证码，直接放行
  const info = $apis.requestInfo(e.httpContext)
  const body = info.data || {}
  if (info.admin) return
  if (info.authRecord) return

  const dao = $app.dao()
  const rawCode = String(body.code || '')
  if (!/^\d{6}$/.test(rawCode)) {
    throw new BadRequestError('请输入邮箱验证码')
  }
  const email = String(body.email || '').trim().toLowerCase()
  const hash = $security.sha256(email + ':' + rawCode + ':' + $app.settings().meta.appName)

  const candidates = dao.findRecordsByFilter(
    'verifications',
    'email = {:email} && used = false',
    '-created',
    5,
    0,
    { email }
  )
  const now = Date.now()
  let matched = null
  for (let i = 0; i < candidates.length; i++) {
    const rec = candidates[i]
    if (rec.getString('code_hash') !== hash) continue
    if (new Date(rec.getString('expires')).getTime() < now) continue
    matched = rec
    break
  }
  if (!matched) {
    throw new BadRequestError('验证码错误或已过期')
  }
  matched.set('used', true)
  dao.saveRecord(matched)

  // code 不是集合字段，先摘掉再交给后续校验
  delete body.code
  if (e.data && typeof e.data.delete === 'function') {
    e.data.delete('code')
  }
}, 'users')

// 每小时清理 1 天前的验证码记录
cronAdd('cleanup-verifications', '0 * * * *', () => {
  const dao = $app.dao()
  const cutoff = new Date(Date.now() - 86400000).toISOString()
  const old = dao.findRecordsByFilter('verifications', 'created < {:cutoff}', '', 500, 0, { cutoff })
  for (let i = 0; i < old.length; i++) {
    dao.deleteRecord(old[i])
  }
})

// ---------------------------------------------------------------------------
// 第三方网关转发
//
//   POST /api/llm/forward
//   { protocol: 'anthropic' | 'openai', url, apiKey, body }
//
// 为什么需要它：多数第三方网关（智谱等）的 OPTIONS 预检被 WAF 拦截、不返回 CORS 头，
// 浏览器无法直连。本站同源转发可绕开跨域限制。
//
// 注意：使用该通道时 API Key 会经过本服务器内存。
// 我们不落库、不写日志、不缓存；请求结束即丢弃。
// ---------------------------------------------------------------------------

routerAdd('POST', '/api/llm/forward', (c) => {
  const info = $apis.requestInfo(c)
  if (!info.authRecord) {
    throw new UnauthorizedError('请先登录')
  }

  const data = info.data || {}
  const protocol = String(data.protocol || 'openai')
  const target = String(data.url || '')
  const apiKey = String(data.apiKey || '')
  const payload = data.body

  if (!target || !payload) {
    throw new BadRequestError('缺少 url 或 body')
  }
  if (target.indexOf('https://') !== 0) {
    throw new BadRequestError('只允许 https 目标')
  }
  if (!/\/(messages|chat\/completions)\/?$/.test(target)) {
    throw new BadRequestError('目标必须是 messages 或 chat/completions 端点')
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (apiKey) {
    if (protocol === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = 'Bearer ' + apiKey
    }
  }

  // PB 的 $http 不支持流式回写，这里整体缓冲后返回；
  // 前端因此按「一次性返回」处理（无打字机效果），换取可用的第三方通道。
  const result = $http.send({
    url: target,
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    timeout: 180,
  })

  const contentType =
    (result.headers['content-type'] && result.headers['content-type'][0]) || 'application/json'
  c.response().header().set('Content-Type', contentType)
  c.response().header().set('Cache-Control', 'no-store')
  c.response().write(result.raw)
  return c.noContent(result.statusCode || 200)
})
