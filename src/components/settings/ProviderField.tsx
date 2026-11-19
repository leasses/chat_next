/**
 * 模型通道选择：DeepSeek 官方（浏览器直连）/ 第三方网关（经本站转发）。
 * 第三方通道会明确提示「Key 会经过服务器」。
 */
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  useProvider,
  setProviderMode,
  setProviderBaseUrl,
  setProviderModel,
  setGatewayProtocol,
  endpointFor,
} from '../../services/provider.js'
import { pushProvider } from '../../lib/secretSync.js'
import { IconSparkOutline16, IconGatewayOutline16 } from '../base/icons.js'
import styles from './Settings.module.css'

export const ProviderField = () => {
  const t = useTranslate()
  const config = useProvider()
  const [baseUrlDraft, setBaseUrlDraft] = useState(config.baseUrl)
  const [modelDraft, setModelDraft] = useState(config.model)

  // 同步引擎解密出远端配置后回填
  useEffect(() => {
    setBaseUrlDraft(config.baseUrl)
    setModelDraft(config.model)
  }, [config.baseUrl, config.model])

  const custom = config.mode === 'custom'

  const commit = () => {
    setProviderBaseUrl(baseUrlDraft.trim())
    setProviderModel(modelDraft.trim())
    void pushProvider()
  }

  return (
    <div className={styles.cell}>
      <div className={styles.label}>{t('providerSection')}</div>
      <div className={styles.description}>{t('providerDescription')}</div>

      <div className={styles.providerOptions} role="radiogroup">
        <button
          type="button"
          role="radio"
          aria-checked={!custom}
          className={clsx(styles.providerOption, !custom && styles.providerOptionSelected)}
          onClick={() => {
            setProviderMode('deepseek')
            void pushProvider()
          }}
        >
          <IconSparkOutline16 />
          <span className={styles.providerOptionLabel}>{t('providerDeepseek')}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className={clsx(styles.providerOption, custom && styles.providerOptionSelected)}
          onClick={() => {
            setProviderMode('custom')
            void pushProvider()
          }}
        >
          <IconGatewayOutline16 />
          <span className={styles.providerOptionLabel}>{t('providerCustom')}</span>
        </button>
      </div>

      <div className={styles.description}>
        {custom ? t('providerCustomHint') : t('providerDeepseekHint')}
      </div>

      {custom ? (
        <>
          {/* 事实陈述：使用该通道时 Key 会经过本站服务器 */}
          <div
            role="note"
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l3)',
              background: 'var(--dsw-alias-bg-layer-3)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            ⚠️ {t('providerProxyWarning')}
          </div>

          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <label className={styles.label}>{t('providerProtocol')}</label>
            <div className={styles.protocolOptions} role="radiogroup">
              {(['anthropic', 'openai'] as const).map((protocol) => (
                <button
                  key={protocol}
                  type="button"
                  role="radio"
                  aria-checked={config.protocol === protocol}
                  className={clsx(
                    styles.protocolOption,
                    config.protocol === protocol && styles.providerOptionSelected
                  )}
                  onClick={() => {
                    setGatewayProtocol(protocol)
                    void pushProvider()
                  }}
                >
                  {protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'}
                </button>
              ))}
            </div>

            <label className={styles.label} htmlFor="provider-base-url">
              {t('providerBaseUrl')}
            </label>
            <input
              id="provider-base-url"
              className={styles.apiKeyInput}
              style={{ padding: '8px 10px' }}
              type="url"
              spellCheck={false}
              autoComplete="off"
              placeholder={t('providerBaseUrlPlaceholder')}
              value={baseUrlDraft}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              onBlur={commit}
            />

            <label className={styles.label} htmlFor="provider-model">
              {t('providerModel')}
            </label>
            <input
              id="provider-model"
              className={styles.apiKeyInput}
              style={{ padding: '8px 10px' }}
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={t('providerModelPlaceholder')}
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              onBlur={commit}
            />

            {baseUrlDraft.trim() ? (
              <div className={styles.description}>
                → {endpointFor({ ...config, baseUrl: baseUrlDraft, model: modelDraft })}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}