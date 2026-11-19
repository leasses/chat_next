/**
 * 第三方网关转发：把请求交给本站服务端，再由服务端请求上游。
 *
 * 走这里的原因：第三方网关的 OPTIONS 预检通常被 WAF 拦截，
 * 浏览器直连必然 CORS 失败；同源请求不受此限制。
 *
 * 代价：API Key 会经过服务器内存（不落库、不写日志）。
 */
import { pb } from './pb.js'
import { warn } from './logger.js'

export type GatewayRequest = {
  protocol: 'anthropic' | 'openai'
  url: string
  apiKey: string
  body: unknown
}

export type GatewayResponse = {
  ok: boolean
  status: number
  text: string
  contentType: string
}

/** 发起一次转发请求；网络或服务端错误以 ok=false 返回，由调用方转成用户可读提示 */
export async function forwardToGateway(request: GatewayRequest): Promise<GatewayResponse> {
  warn('gateway', 'forward request', {
    protocol: request.protocol,
    url: request.url,
  })
  try {
    const response = await fetch('/api/llm/forward', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: pb.authStore.token,
      },
      body: JSON.stringify(request),
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      text,
      contentType: response.headers.get('Content-Type') ?? 'application/json',
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: error instanceof Error ? error.message : String(error),
      contentType: 'text/plain',
    }
  }
}
