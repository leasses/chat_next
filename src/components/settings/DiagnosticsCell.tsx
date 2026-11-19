/**
 * 诊断与日志：把运行环境、能力检测与最近的运行日志打包成一段文本。
 * 日志在写入时已脱敏（密钥、salt、Bearer token 都会被替换），可放心发送。
 */
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useChatStore } from '../../services/chat/store.js'
import { exportLog, getEntries } from '../../lib/logger.js'
import styles from './Settings.module.css'

const supports = (name: string, test: () => boolean): string => {
  try {
    return `${name}: ${test() ? 'ok' : 'MISSING'}`
  } catch {
    return `${name}: error`
  }
}

const envInfo = (sessionCount: number): Record<string, string> => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  const capability = [
    supports('Object.hasOwn', () => typeof Object.hasOwn === 'function'),
    supports('Array.toSorted', () => typeof (Array.prototype as unknown as Record<string, unknown>).toSorted === 'function'),
    supports('Array.at', () => typeof (Array.prototype as unknown as Record<string, unknown>).at === 'function'),
    supports('crypto.randomUUID', () => typeof crypto.randomUUID === 'function'),
    supports('crypto.subtle', () => Boolean(crypto.subtle)),
    supports('Blob.slice', () => typeof Blob.prototype.slice === 'function'),
    supports('indexedDB', () => 'indexedDB' in window),
    supports('TextDecoder', () => typeof TextDecoder === 'function'),
  ].join('\n')
  return {
    sessions: String(sessionCount),
    deviceMemory: `${nav.deviceMemory ?? 'n/a'} GB`,
    capability,
  }
}

export const DiagnosticsCell = () => {
  const t = useTranslate()
  const sessionCount = useChatStore((state) => state.sessions.length)
  const [state, setState] = useState<'idle' | 'copied'>('idle')
  // 无法访问剪贴板（非 HTTPS / 旧 WebView）时，把文本展开到页面上让用户手动长按复制
  const [fallback, setFallback] = useState<string | null>(null)

  const build = () => exportLog(envInfo(sessionCount))

  const copy = async () => {
    const text = build()
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      setFallback(text)
      showToast({ key: 'diagnosticCopy', type: 'error' })
    }
  }

  const download = () => {
    const text = build()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `chat-demo-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const count = getEntries().length

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('diagnosticTitle')}</div>
          <div className={styles.description}>
            {t('diagnosticDescription')}（{count}）
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outlined" size="m" className={styles.cellButton} onClick={download}>
            {t('diagnosticDownload')}
          </Button>
          <Button variant="outlined" size="m" className={styles.cellButton} onClick={() => void copy()}>
            {state === 'copied' ? t('diagnosticCopied') : t('diagnosticCopy')}
          </Button>
        </div>
      </div>
      {fallback ? (
        <textarea
          className={styles.apiKeyInput}
          style={{ width: '100%', marginTop: 8, minHeight: 140, fontFamily: 'monospace', fontSize: 11 }}
          readOnly
          value={fallback}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </div>
  )
}
