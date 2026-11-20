/**
 * 认证状态机：boot → login/unlock → ready。
 * - 密码仅用于：PocketBase 鉴权 + 本地 PBKDF2 派生 AES-256-GCM 密钥；
 * - 密钥与明文密码不落 localStorage，锁定/退出即清内存；
 * - 忘记密码无法恢复数据，仅支持「清空加密数据并重建」（产品明示）。
 */
import { create } from 'zustand'
import { deriveKey, generateSalt } from './crypto.js'
import {
  pb,
  signIn,
  signUp,
  requestEmailCode,
  ensureSalt,
  overwriteSalt,
  wipeServerData,
  currentUser,
  getPbUrl,
  setPbUrl,
} from './pb.js'
import * as sync from './syncEngine.js'
import { loadSecretIntoMemory, pushSecret } from './secretSync.js'
import { resetForLock } from '../services/chat/store.js'
import * as db from '../services/chat/db.js'
import { setApiKeyMemory, useSettings } from '../services/settings.js'
import { translate } from '../i18n/index.js'

export type AuthPhase = 'boot' | 'login' | 'unlock' | 'ready'

type AuthState = {
  phase: AuthPhase
  email: string
  error: string | null
  busy: boolean
  /** 密钥校验失败（密码在别处被重置等），可走清空重建 */
  needsWipe: boolean
  pbUrl: string
}

export const useAuthStore = create<AuthState>(() => ({
  phase: 'boot',
  email: '',
  error: null,
  busy: false,
  needsWipe: false,
  pbUrl: getPbUrl(),
}))

const setState = useAuthStore.setState

/** PocketBase 报错转界面文案；不回显服务端原始堆栈 */
const friendlyError = (error: unknown): string => {
  if (error instanceof TypeError) {
    return translate('errNetwork')
  }
  const status = (error as { status?: number } | null)?.status
  const data = (error as { response?: { data?: Record<string, { message?: string; code?: string }> } })
    ?.response?.data
  const code = data ? Object.values(data)[0]?.code : undefined
  // 注册时的字段校验（邮箱格式、密码太短、邮箱已被占用）与登录失败是不同的 400，不能混为一谈
  if (code?.startsWith('validation_')) {
    const field = Object.keys(data ?? {})[0] ?? ''
    if (code === 'validation_not_unique') {
      return translate('errEmailTaken')
    }
    if (field === 'email') {
      return translate('errEmailInvalid')
    }
    if (field.startsWith('password')) {
      return translate('errPasswordShort')
    }
    return translate('errInvalidField', { field })
  }
  // 验证码 / 限流等业务错误由服务端 hook 返回中文 message，原样透出
  const serverMessage = (error as { response?: { message?: string } } | null)?.response?.message
  if (status === 400 && serverMessage && /验证码|频繁|上限|邮箱/.test(serverMessage)) {
    return serverMessage
  }
  if (status === 400 || status === 401 || status === 404) {
    return translate('errCredentials')
  }
  if (status === 429) {
    return translate('errTooMany')
  }
  const message = error instanceof Error ? error.message : String(error)
  return /failed to fetch/i.test(message)
    ? translate('errNetwork')
    : translate('errGeneric', { message })
}

// 启动：SDK 恢复的会话有效则进入解锁态，否则登录态
const user = currentUser()
setState({
  phase: user ? 'unlock' : 'login',
  email: user?.email ?? '',
})

export const actions = {
  setPbUrl(url: string): void {
    if (url && url !== getPbUrl()) {
      setPbUrl(url) // 内部会刷新页面
    }
  },

  async login(email: string, password: string): Promise<void> {
    setState({ busy: true, error: null })
    try {
      const authUser = await signIn(email.trim(), password)
      await ensureSalt(authUser)
      setState({ email: authUser.email, phase: 'unlock', busy: false, needsWipe: false })
    } catch (error) {
      setState({ busy: false, error: friendlyError(error) })
    }
  },

  /** 发送邮箱验证码；返回 true 表示已发出，界面据此开始倒计时 */
  async sendCode(email: string): Promise<boolean> {
    setState({ error: null })
    try {
      await requestEmailCode(email.trim())
      return true
    } catch (error) {
      setState({ error: friendlyError(error) })
      return false
    }
  },

  async register(email: string, password: string, code: string): Promise<void> {
    setState({ busy: true, error: null })
    try {
      const authUser = await signUp(email.trim(), password, code.trim())
      await ensureSalt(authUser)
      setState({ email: authUser.email, phase: 'unlock', busy: false, needsWipe: false })
    } catch (error) {
      setState({ busy: false, error: friendlyError(error) })
    }
  },

  /** 解锁：派生密钥 → 全量拉取 + 解密探针 → 启动同步 → 进主界面 */
  async unlock(password: string): Promise<void> {
    const user = currentUser()
    if (!user?.crypto_salt) {
      setState({ error: translate('errNoSalt') })
      return
    }
    setState({ busy: true, error: null, needsWipe: false })
    try {
      const key = await deriveKey(password, user.crypto_salt)
      const result = await sync.start(user.id, key)
      // eslint-disable-next-line no-console
      if (!result.ok) {
        sync.stop()
        setState({
          busy: false,
          needsWipe: result.reason === 'decrypt',
          error:
            result.reason === 'decrypt'
              ? translate('errKeyMismatch')
              : translate('errNetwork'),
        })
        return
      }
      // 先恢复云端配置（通道模式、Base URL、模型名、Key），保证换设备登录即可用；
      // 老版本遗留在 localStorage 的 key 仅在云端没有记录时补推。
      await loadSecretIntoMemory()
      const legacy = useLegacyApiKey()
      if (legacy && !useSettings.getState().apiKey) {
        setApiKeyMemory(legacy)
        void pushSecret(legacy)
      }
      setState({ phase: 'ready', busy: false, error: null })
    } catch (error) {
      sync.stop()
      setState({ busy: false, error: friendlyError(error) })
    }
  },

  /** 清空加密数据并重建：删除服务端全部密文、重置 salt、清空本地明文 */
  async resetData(): Promise<void> {
    const user = currentUser()
    if (!user) {
      return
    }
    setState({ busy: true, error: null })
    try {
      sync.stop()
      await wipeServerData(user.id)
      await overwriteSalt(user.id, generateSalt())
      await db.wipeLocal()
      setState({ busy: false, needsWipe: false, error: null })
    } catch (error) {
      setState({ busy: false, error: friendlyError(error) })
    }
  },

  /** 锁定：停同步、清内存密钥与会话明文，回到解锁页 */
  lock(): void {
    sync.stop()
    resetForLock()
    setApiKeyMemory(null)
    setState({ phase: 'unlock', error: null, needsWipe: false })
  },

  /** 退出登录：锁定 + 清服务端会话凭据 + 清本地明文 */
  async logout(): Promise<void> {
    sync.stop()
    resetForLock()
    setApiKeyMemory(null)
    try {
      await db.wipeLocal()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[auth] wipe local failed', error)
    }
    pb.authStore.clear()
    setState({ phase: 'login', email: '', error: null, needsWipe: false })
  },
}

/** 读取并移除老版本遗留在 localStorage 的 API Key（只进内存，不再落盘） */
function useLegacyApiKey(): string | null {
  try {
    const legacy = localStorage.getItem('chat-demo:api-key')
    if (legacy !== null) {
      localStorage.removeItem('chat-demo:api-key')
      setApiKeyMemory(legacy)
      return legacy
    }
  } catch {
    // 存储不可用时跳过
  }
  return null
}