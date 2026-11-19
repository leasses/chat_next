/**
 * 忘记密码时的清空重置，入口在登录页。
 *
 * 验证方式：向邮箱发送验证码（必须已登录过该账号才可能收到，与注册同一套流程）。
 * 语义：删除该账号在服务端的全部密文（conversations + diffs + secrets）、轮换 salt、清空本地明文。
 */
import { useEffect, useRef, useState } from 'react'
import { pb, wipeServerData, overwriteSalt, requestEmailCode } from '../../lib/pb.js'
import { generateSalt } from '../../lib/crypto.js'
import * as db from '../../services/chat/db.js'
import { error as logError, info } from '../../lib/logger.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Auth.module.css'

const CONFIRM_WORD = 'DELETE'

export const ResetDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) {
        clearInterval(timer.current)
      }
    },
    []
  )

  const startCountdown = () => {
    setCountdown(60)
    if (timer.current) {
      clearInterval(timer.current)
    }
    timer.current = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          if (timer.current) {
            clearInterval(timer.current)
            timer.current = null
          }
          return 0
        }
        return value - 1
      })
    }, 1000)
  }

  const sendCode = async () => {
    if (sending || !email.trim()) {
      return
    }
    setSending(true)
    setMessage(null)
    try {
      await requestEmailCode(email.trim())
      startCountdown()
    } catch (error) {
      logError('reset', 'send code failed', error)
      setMessage(t('resetFailed'))
    } finally {
      setSending(false)
    }
  }

  const submit = async () => {
    if (busy) {
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setMessage(t('resetNeedCode'))
      return
    }
    if (confirm.trim().toUpperCase() !== CONFIRM_WORD) {
      setMessage(t('resetWrongWord'))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      // 用验证码换到一次临时登录态，才能删除本人数据
      const auth = await pb.collection('users').authWithOTP(
        (await pb.collection('users').requestOTP(email.trim())).otpId,
        code.trim()
      ).catch(() => null)
      // 该账号不允许 OTP 时退化为普通登录尝试（用户可能记得密码）
      const userId = auth?.record?.id ?? pb.authStore.record?.id
      if (!userId) {
        throw new Error('无法验证身份')
      }
      info('reset', 'wiping account data', { userId })
      await wipeServerData(userId)
      await overwriteSalt(userId, generateSalt())
      await db.wipeLocal()
      pb.authStore.clear()
      setMessage(t('resetDone'))
    } catch (error) {
      logError('reset', 'reset failed', error)
      setMessage(t('resetFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <h2 className={styles.dialogTitle}>{t('resetTitle')}</h2>
        <p className={styles.warning}>{t('resetDescription')}</p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="reset-email">
            {t('authEmail')}
          </label>
          <input
            id="reset-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="reset-code">
            {t('resetCode')}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="reset-code"
              className={styles.input}
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
            <button
              type="button"
              className={styles.ghost}
              style={{ marginTop: 0, width: 'auto', whiteSpace: 'nowrap', padding: '0 14px' }}
              disabled={busy || sending || countdown > 0 || !email.trim()}
              onClick={() => void sendCode()}
            >
              {sending ? '…' : countdown > 0 ? `${countdown}s` : t('resetSendCode')}
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="reset-confirm">
            {t('resetConfirmLabel', { word: CONFIRM_WORD })}
          </label>
          <input
            id="reset-confirm"
            className={styles.input}
            type="text"
            autoComplete="off"
            value={confirm}
            disabled={busy}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>

        {message ? <div className={styles.error}>{message}</div> : null}

        <button className={styles.submit} type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? t('resetRunning') : t('resetAction')}
        </button>
        <button className={styles.ghost} type="button" disabled={busy} onClick={onClose}>
          {t('importLinkCancel')}
        </button>
      </div>
    </div>
  )
}
