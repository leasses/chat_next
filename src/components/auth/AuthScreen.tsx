/**
 * 登录 / 注册 / 解锁界面。锁定与未登录时遮罩整个应用。
 * 密码同时用于账号鉴权与本地派生加密密钥；忘记密码无法恢复数据（界面明示）。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { actions, useAuthStore } from '../../lib/authStore.js'
import { ResetDialog } from './ResetDialog.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Auth.module.css'

type Mode = 'login' | 'register'

export const AuthScreen = () => {
  const t = useTranslate()
  const phase = useAuthStore((s) => s.phase)
  const email = useAuthStore((s) => s.email)
  const error = useAuthStore((s) => s.error)
  const busy = useAuthStore((s) => s.busy)
  const needsWipe = useAuthStore((s) => s.needsWipe)
  const pbUrl = useAuthStore((s) => s.pbUrl)

  const [mode, setMode] = useState<Mode>('login')
  const [inputEmail, setInputEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [sending, setSending] = useState(false)
  const [urlDraft, setUrlDraft] = useState(pbUrl)
  const [resetOpen, setResetOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 验证码倒计时：只在开始时创建定时器，归零自动销毁；卸载时清理
  const startCountdown = () => {
    setCountdown(60)
    if (timerRef.current) {
      clearInterval(timerRef.current)
    }
    timerRef.current = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
          return 0
        }
        return value - 1
      })
    }, 1000)
  }

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    },
    []
  )


  if (phase === 'boot') {
    return null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    if (phase === 'unlock') {
      await actions.unlock(password)
      return
    }
    if (mode === 'register') {
      if (password !== confirm) {
        useAuthStore.setState({ error: t('authPasswordMismatch') })
        return
      }
      if (!/^\d{6}$/.test(code.trim())) {
        useAuthStore.setState({ error: t('authCodeRequired') })
        return
      }
    }
    if (mode === 'login') {
      await actions.login(inputEmail, password)
    } else {
      await actions.register(inputEmail, password, code)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {phase === 'unlock' ? (
          <>
            <h1 className={styles.brand}>{t('authUnlockTitle', { email })}</h1>
            <p className={styles.subtitle}>{t('authUnlockSubtitle')}</p>
            {error ? <div className={styles.error}>{error}</div> : null}
            <form onSubmit={submit}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="auth-password">
                  {t('authPassword')}
                </label>
                <input
                  id="auth-password"
                  className={styles.input}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  autoFocus
                  required
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <button className={styles.submit} type="submit" disabled={busy || !password}>
                {busy ? t('authUnlocking') : t('authUnlockAction')}
              </button>
            </form>
            {needsWipe ? (
              <button
                className={styles.ghost}
                type="button"
                disabled={busy}
                onClick={() => void actions.resetData()}
              >
                {busy ? t('authWorking') : t('resetAction')}
              </button>
            ) : null}
            <p className={styles.warning}>
              {t('authForgotWarning')}
            </p>
            <button className={styles.switch} type="button" onClick={() => void actions.logout()}>
              {t('authSwitchAccount')}
            </button>
            <button className={styles.switch} type="button" onClick={() => setResetOpen(true)}>
              {t('resetEntry')}
            </button>
            {resetOpen ? <ResetDialog onClose={() => setResetOpen(false)} /> : null}
          </>
        ) : (
          <>
            <h1 className={styles.brand}>{t('authBrand')}</h1>
            <p className={styles.subtitle}>{t('authTagline')}</p>
            {error ? <div className={styles.error}>{error}</div> : null}
            <div className={styles.tabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'login'}
                className={[styles.tab, mode === 'login' ? styles.tabActive : ''].join(' ')}
                onClick={() => setMode('login')}
              >
                {t('authLoginTab')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'register'}
                className={[styles.tab, mode === 'register' ? styles.tabActive : ''].join(' ')}
                onClick={() => setMode('register')}
              >
                {t('authRegisterTab')}
              </button>
            </div>
            <form onSubmit={submit}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="auth-email">
                  {t('authEmail')}
                </label>
                <input
                  id="auth-email"
                  className={styles.input}
                  type="email"
                  value={inputEmail}
                  autoComplete="email"
                  autoFocus
                  required
                  disabled={busy}
                  onChange={(event) => setInputEmail(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="auth-password">
                  {t('authPassword')}
                </label>
                <input
                  id="auth-password"
                  className={styles.input}
                  type="password"
                  value={password}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={8}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              {mode === 'register' ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="auth-code">
                    {t('authCode')}
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="auth-code"
                      className={styles.input}
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      placeholder={t('authCodePlaceholder')}
                      autoComplete="one-time-code"
                      disabled={busy}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                    />
                    <button
                      type="button"
                      className={styles.ghost}
                      style={{ marginTop: 0, width: 'auto', whiteSpace: 'nowrap', padding: '0 14px' }}
                      disabled={busy || sending || countdown > 0 || !inputEmail}
                      onClick={async () => {
                        setSending(true)
                        const ok = await actions.sendCode(inputEmail)
                        setSending(false)
                        if (ok) {
                          startCountdown()
                        }
                      }}
                    >
                      {sending ? t('authSendingCode') : countdown > 0 ? `${countdown}s` : t('authSendCode')}
                    </button>
                  </div>
                </div>
              ) : null}
              {mode === 'register' ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="auth-confirm">
                    {t('authConfirmPassword')}
                  </label>
                  <input
                    id="auth-confirm"
                    className={styles.input}
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    disabled={busy}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </div>
              ) : null}
              <button className={styles.submit} type="submit" disabled={busy || !inputEmail || !password}>
                {busy ? t('authWorkingShort') : mode === 'login' ? t('authLoginSubmit') : t('authRegisterSubmit')}
              </button>
            </form>
            <p className={styles.warning}>
              {mode === 'register'
                ? t('authRegisterNotice')
                : ''}
            </p>
            <button className={styles.switch} type="button" onClick={() => setResetOpen(true)}>
              {t('resetEntry')}
            </button>
            {resetOpen ? <ResetDialog onClose={() => setResetOpen(false)} /> : null}
            <details className={styles.details}>
              <summary>{t('authServerAddress')}</summary>
              <div className={styles.field} style={{ marginTop: 8 }}>
                <input
                  className={styles.input}
                  type="url"
                  value={urlDraft}
                  disabled={busy}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="http://127.0.0.1:8090"
                />
              </div>
              <button
                className={styles.ghost}
                type="button"
                disabled={busy || !urlDraft}
                onClick={() => actions.setPbUrl(urlDraft)}
              >
                {t('authServerSave')}
              </button>
            </details>
          </>
        )}
      </div>
    </div>
  )
}