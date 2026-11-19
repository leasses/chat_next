/**
 * 模型通道配置。
 *
 * - deepseek：DeepSeek 官方，浏览器直连，Key 不经过服务器
 * - custom  ：第三方网关，经本站服务端转发（网关预检通常被 WAF 拦截，浏览器无法直连）
 *
 * 使用 custom 通道时 API Key 会经过服务器内存（不落库、不写日志），界面已明确提示。
 */
import { create } from 'zustand'

export type ProviderMode = 'deepseek' | 'custom'

/** 第三方网关的协议：Anthropic Messages 或 OpenAI Chat Completions */
export type GatewayProtocol = 'anthropic' | 'openai'

export type ProviderConfig = {
  mode: ProviderMode
  /** 自定义端点的 base URL，如 https://open.bigmodel.cn/api/anthropic */
  baseUrl: string
  /** 自定义模型名，如 glm-4.7-flash */
  model: string
  protocol: GatewayProtocol
}

const KEYS = {
  mode: 'chat-demo:provider-mode',
  baseUrl: 'chat-demo:provider-base-url',
  model: 'chat-demo:provider-model',
  protocol: 'chat-demo:provider-protocol',
} as const

const read = (key: string, fallback: string): string => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value
  } catch {
    return fallback
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

export const useProvider = create<ProviderConfig>(() => ({
  mode: read(KEYS.mode, 'deepseek') === 'custom' ? 'custom' : 'deepseek',
  baseUrl: read(KEYS.baseUrl, ''),
  model: read(KEYS.model, ''),
  protocol: read(KEYS.protocol, 'anthropic') === 'openai' ? 'openai' : 'anthropic',
}))

export const setProviderMode = (mode: ProviderMode) => {
  write(KEYS.mode, mode)
  useProvider.setState({ mode })
}

export const setProviderBaseUrl = (baseUrl: string) => {
  write(KEYS.baseUrl, baseUrl)
  useProvider.setState({ baseUrl })
}

export const setProviderModel = (model: string) => {
  write(KEYS.model, model)
  useProvider.setState({ model })
}

export const setGatewayProtocol = (protocol: GatewayProtocol) => {
  write(KEYS.protocol, protocol)
  useProvider.setState({ protocol })
}

export const isCustomReady = (config: ProviderConfig = useProvider.getState()): boolean =>
  Boolean(config.baseUrl.trim() && config.model.trim())

/** 把 base URL 归一化成完整的 messages 地址 */
export const anthropicUrl = (baseUrl: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(base)) {
    return base
  }
  if (/\/v1$/.test(base)) {
    return base + '/messages'
  }
  return base + '/v1/messages'
}

/** 把 base URL 归一化成完整的 chat/completions 地址 */
export const openaiUrl = (baseUrl: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(base)) {
    return base
  }
  return base + '/chat/completions'
}

export const endpointFor = (config: ProviderConfig): string =>
  config.protocol === 'anthropic' ? anthropicUrl(config.baseUrl) : openaiUrl(config.baseUrl)