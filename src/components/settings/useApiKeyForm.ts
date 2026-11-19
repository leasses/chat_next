import { useState } from 'react'
import { ApiError, verifyApiKey } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKeyMemory } from '../../services/settings.js'
import { useProvider } from '../../services/provider.js'
import { useTranslate } from '../../i18n/index.js'

/**
 * 保存 API Key。
 * 官方通道先 GET /models 验证（不产生费用）；第三方网关的 key 格式各异、
 * 也常不实现 /models，直接接受，由实际请求时上游返回错误。
 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      if (useProvider.getState().mode === 'custom') {
        setApiKeyMemory(apiKey)
      } else {
        await verifyApiKey(apiKey)
        setApiKeyMemory(apiKey)
      }
      setValue('')
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}