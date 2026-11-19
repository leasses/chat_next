/**
 * 运行时日志：环形缓冲，供用户导出定位问题。
 *
 * 安全：写入前统一脱敏 —— 任何看起来像密钥的字符串（sk-、长十六进制、Bearer token）
 * 都会被替换成 [redacted]，会话正文与 API Key 永不进入日志。
 */

const MAX_ENTRIES = 600

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogEntry = {
  /** 相对启动的毫秒数 */
  t: number
  level: LogLevel
  scope: string
  message: string
  /** 附加数据（已脱敏、已截断） */
  data?: string
}

const startedAt = Date.now()
const entries: LogEntry[] = []

/** 把敏感片段替换掉；宁可多脱敏，也不要漏 */
const redact = (text: string): string =>
  text
    // Bearer xxx / x-api-key: xxx
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/((?:x-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]{6,}/gi, '$1[redacted]')
    // OpenAI / DeepSeek 风格
    .replace(/\bsk-[A-Za-z0-9._-]{10,}/g, 'sk-[redacted]')
    // 智谱风格 32hex.16位
    .replace(/\b[0-9a-f]{32}\.[A-Za-z0-9]{10,}/g, '[redacted]')
    // 32~64 位纯十六进制（salt / 摘要）
    .replace(/\b[0-9a-f]{32,64}\b/gi, '[redacted-hex]')

const stringify = (value: unknown): string => {
  if (value === undefined) {
    return ''
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    // 单条附加数据最多 800 字符，避免日志膨胀
    return text.length > 800 ? text.slice(0, 800) + '…' : text
  } catch {
    return '[unserializable]'
  }
}

export const log = (level: LogLevel, scope: string, message: string, data?: unknown): void => {
  const entry: LogEntry = {
    t: Date.now() - startedAt,
    level,
    scope,
    message: redact(message),
  }
  const extra = data === undefined ? '' : stringify(data)
  if (extra) {
    entry.data = redact(extra)
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.shift()
  }
  // 开发期仍然打到控制台；生产不打扰用户
  if (typeof window !== 'undefined' && window.location.port === '8090') {
    // eslint-disable-next-line no-console
    console.log(`[${scope}] ${entry.message}`, entry.data ?? '')
  }
}

export const debug = (scope: string, message: string, data?: unknown): void =>
  log('debug', scope, message, data)
export const info = (scope: string, message: string, data?: unknown): void =>
  log('info', scope, message, data)
export const warn = (scope: string, message: string, data?: unknown): void =>
  log('warn', scope, message, data)
export const error = (scope: string, message: string, data?: unknown): void =>
  log('error', scope, message, data)

export const getEntries = (): LogEntry[] => [...entries]

export const clearEntries = (): void => {
  entries.length = 0
}

/** 把一条日志渲染成单行文本 */
const formatEntry = (entry: LogEntry): string => {
  const stamp = (entry.t / 1000).toFixed(3).padStart(8)
  const line = `${stamp}s ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`
  return entry.data ? `${line} | ${entry.data}` : line
}

/** 生成可复制/下载的完整日志文本（含环境信息） */
export const exportLog = (extra: Record<string, string> = {}): string => {
  const env: string[] = [
    '=== Environment ===',
    `UA: ${navigator.userAgent}`,
    `viewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`,
    `online: ${navigator.onLine}`,
    `secureContext: ${window.isSecureContext}`,
    `lang: ${navigator.language}`,
    `time: ${new Date().toISOString()}`,
  ]
  for (const [key, value] of Object.entries(extra)) {
    env.push(`${key}: ${value}`)
  }
  const body = entries.length > 0 ? entries.map(formatEntry).join('\n') : '(no entries)'
  return `${env.join('\n')}\n\n=== Log (${entries.length} entries) ===\n${redact(body)}\n`
}