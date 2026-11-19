/**
 * 运行时兼容垫片。
 *
 * 手机上常通过微信 / Via / 系统浏览器打开，它们内嵌的 WebView 版本往往比桌面落后好几年：
 * - Object.hasOwn 是 ES2022（Chrome 93+）
 * - Array.prototype.toSorted / toReversed 是 ES2023（Chrome 110+）
 * 缺失时会在调用处抛 TypeError，表现出来就是「点了没反应」或界面卡住。
 *
 * 这里在应用启动前补齐；只在缺失时定义，不覆盖原生实现。
 */

type AnyRecord = Record<string, unknown>

const define = (target: object, name: string, value: unknown): void => {
  if (!(name in target)) {
    Object.defineProperty(target, name, { value, configurable: true, writable: true })
  }
}

export const installPolyfills = (): void => {
  // Object.hasOwn（ES2022）
  if (typeof Object.hasOwn !== 'function') {
    define(Object, 'hasOwn', (object: unknown, key: PropertyKey): boolean =>
      Object.prototype.hasOwnProperty.call(object as AnyRecord, key)
    )
  }

  const arrayProto = Array.prototype as unknown as AnyRecord

  // Array.prototype.toSorted（ES2023）
  if (typeof arrayProto.toSorted !== 'function') {
    define(Array.prototype, 'toSorted', function toSorted<T>(
      this: T[],
      compare?: (a: T, b: T) => number
    ): T[] {
      return this.slice().sort(compare)
    })
  }

  // Array.prototype.toReversed（ES2023）
  if (typeof arrayProto.toReversed !== 'function') {
    define(Array.prototype, 'toReversed', function toReversed<T>(this: T[]): T[] {
      return this.slice().reverse()
    })
  }

  // Array.prototype.at（ES2022）
  if (typeof arrayProto.at !== 'function') {
    define(Array.prototype, 'at', function at<T>(this: T[], index: number): T | undefined {
      const length = this.length
      const relative = Math.trunc(index) || 0
      const position = relative < 0 ? length + relative : relative
      return position < 0 || position >= length ? undefined : this[position]
    })
  }

  // String.prototype.at（ES2022）
  const stringProto = String.prototype as unknown as AnyRecord
  if (typeof stringProto.at !== 'function') {
    define(String.prototype, 'at', function at(this: string, index: number): string | undefined {
      const length = this.length
      const relative = Math.trunc(index) || 0
      const position = relative < 0 ? length + relative : relative
      return position < 0 || position >= length ? undefined : this[position]
    })
  }

  // crypto.randomUUID（Chrome 92+，且仅安全上下文）
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    define(crypto, 'randomUUID', (): string => {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return (
        hex.slice(0, 8) +
        '-' +
        hex.slice(8, 12) +
        '-' +
        hex.slice(12, 16) +
        '-' +
        hex.slice(16, 20) +
        '-' +
        hex.slice(20)
      )
    })
  }
}
