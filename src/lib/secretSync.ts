/**
 * API Key 密文同步：明文只在内存，落库前在浏览器内加密，服务端只见密文。
 * 换设备登录并解锁后即可直接使用。
 */
import { decryptJSON, encryptJSON } from './crypto.js'
import { currentUser, getSecretRecord, upsertSecret, deleteSecretRecord } from './pb.js'
import { getKey } from './syncEngine.js'
import {
  setGatewayProtocol,
  setProviderBaseUrl,
  setProviderMode,
  setProviderModel,
  useProvider,
} from '../services/provider.js'
import { setApiKeyMemory } from '../services/settings.js'

/** 一份密文里打包的全部内容：key 与通道配置一起同步，换设备登录即可用 */
type SecretPayload = {
  apiKey: string | null
  mode?: 'deepseek' | 'custom'
  baseUrl?: string
  model?: string
  protocol?: 'anthropic' | 'openai'
}

const snapshot = (apiKey: string | null): SecretPayload => {
  const provider = useProvider.getState()
  return {
    apiKey,
    mode: provider.mode,
    baseUrl: provider.baseUrl,
    model: provider.model,
    protocol: provider.protocol,
  }
}

/**
 * 解锁后从服务端拉取密文并解密进内存。
 * 通道配置与 key 是同一条记录，所以一次解密就能恢复完整可用状态。
 */
export async function loadSecretIntoMemory(): Promise<void> {
  const user = currentUser()
  const key = getKey()
  if (!user || !key) {
    return
  }
  try {
    const rec = await getSecretRecord(user.id)
    if (!rec) {
      return
    }
    const data = await decryptJSON<SecretPayload>(rec.cipher, key)
    // 先恢复通道，再写 key
    if (data.mode) {
      setProviderMode(data.mode)
    }
    if (typeof data.baseUrl === 'string') {
      setProviderBaseUrl(data.baseUrl)
    }
    if (typeof data.model === 'string') {
      setProviderModel(data.model)
    }
    if (data.protocol) {
      setGatewayProtocol(data.protocol)
    }
    setApiKeyMemory(data.apiKey ?? null)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[secret] load failed', error)
  }
}

/** API Key 变更后加密上行；null 表示删除 */

export async function pushSecret(apiKey: string | null): Promise<void> {
  const user = currentUser()
  const key = getKey()
  if (!user || !key) {
    return
  }
  try {
    const payload = snapshot(apiKey)
    // key 与通道配置都为空才删除记录
    if (!payload.apiKey && !payload.baseUrl && !payload.model) {
      await deleteSecretRecord(user.id)
      return
    }
    const cipher = await encryptJSON(payload, key)
    await upsertSecret(user.id, cipher)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[secret] push failed', error)
  }
}

/** 通道配置变更后调用：与当前 key 一起重新加密上行 */
export async function pushProvider(): Promise<void> {
  const { useSettings } = await import('../services/settings.js')
  await pushSecret(useSettings.getState().apiKey)
}