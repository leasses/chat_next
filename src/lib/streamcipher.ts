/**
 * 流式加密内核：密文可按 byte offset 增量传输。
 *
 * 性质（与企划书一致）：
 *   同一对话、同一 offset 的明文字节，加密后密文恒等；
 *   尾部追加消息时前面密文不变，因此可以只上传 offset 之后的增量。
 *
 * 与企划书的差异（重要）：
 *   企划书写的是 ciphertext[i] = plaintext[i] ^ key[i % key.length]（等长循环密钥的 XOR）。
 *   那等价于古典一次性密码本，对已知明文攻击是零防护：DeepSeek 导出包的 JSON 结构完全可预测，
 *   攻击者只要知道任意一段明文，就能还原出对应位置的密钥流，进而解密整段对话。
 *   这里改成 PRF 展开的密钥流：keystream = HMAC-SHA256(K, blockIndex)，K 为本对话派生密钥。
 *   - 仍然是纯函数：字节 i 的密钥流只由 (K, i / 32) 决定，与明文体无关 → 同 offset 同密文性质保留；
 *   - 已知明文只能泄露“那一段位置”的密钥流，推不出 K，也影响不到别的对话；
 *   - 每字节多一次 HMAC 块计算（约 200ns），28MB 明文约多 6ms，可忽略。
 */

const BLOCK = 32
/** 一个 HMAC 块展开 32 字节；批处理一次算 64 块（2KB），减少 await 次数 */
const BATCH = 64

/** 每个对话的派生密钥：HMAC-SHA256(masterKey_bytes, "chat-demo-stream-v1:" + cid) */
export async function deriveConversationKey(
  master: CryptoKey,
  cid: string
): Promise<CryptoKey> {
  // master 不可导出，用 encrypt 做一次域分离，得到每个对话独立的 32 字节材料
  const nonce = new Uint8Array(12)
  new TextEncoder().encodeInto('chat-demo-key-v1:' + cid.slice(0, 8), nonce)
  const material = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, master, new TextEncoder().encode(cid))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

/** 生成 [offset, offset + length) 区间的密钥流 */
async function keystream(key: CryptoKey, offset: number, length: number): Promise<Uint8Array> {
  const startBlock = Math.floor(offset / BLOCK)
  const endBlock = Math.ceil((offset + length) / BLOCK)
  const blocks = endBlock - startBlock
  const out = new Uint8Array(blocks * BLOCK)
  const counter = new Uint8Array(8)

  for (let base = 0; base < blocks; base += BATCH) {
    const count = Math.min(BATCH, blocks - base)
    const parts: Promise<ArrayBuffer>[] = []
    for (let i = 0; i < count; i++) {
      const view = new DataView(counter.buffer)
      view.setUint32(0, Math.floor((startBlock + base + i) / 0x100000000))
      view.setUint32(4, (startBlock + base + i) >>> 0)
      parts.push(crypto.subtle.sign('HMAC', key, counter))
    }
    const results = await Promise.all(parts)
    for (let i = 0; i < count; i++) {
      out.set(new Uint8Array(results[i]), (base + i) * BLOCK)
    }
  }
  // 对齐到 offset
  const shift = offset - startBlock * BLOCK
  return out.slice(shift, shift + length)
}

/** XOR 加密全文（= 解密，对称） */
export async function encryptBytes(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const ks = await keystream(key, 0, plain.length)
  const out = new Uint8Array(plain.length)
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ ks[i]
  }
  return out
}

/** 只加密 [offset, end) 区间，用于生成 diff 或做增量校验 */
export async function encryptRange(
  key: CryptoKey,
  plain: Uint8Array,
  offset: number,
  end: number
): Promise<Uint8Array> {
  const ks = await keystream(key, offset, end - offset)
  const out = new Uint8Array(end - offset)
  for (let i = 0; i < out.length; i++) {
    out[i] = plain[offset + i] ^ ks[i]
  }
  return out
}

export async function decryptBytes(key: CryptoKey, cipher: Uint8Array): Promise<Uint8Array> {
  return encryptBytes(key, cipher)
}

// ---------- 编解码 ----------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = (text: string): Uint8Array => encoder.encode(text)
export const decode = (bytes: Uint8Array): string => decoder.decode(bytes)

/** 二进制 → base64（分块处理，避免大数组触发参数长度上限） */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)))
  }
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/** 标准 CRC32（IEEE）；用于检测同步/传输错误，不承担抗篡改职责 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 计算「把 diff 应用到 base 上之后」整段密文的 CRC32。
 * base 是 [0, off) 的旧密文，tail 是 [off, ...) 的新数据。
 */
export function crc32Merged(base: Uint8Array, off: number, tail: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < off; i++) {
    c = CRC_TABLE[(c ^ base[i]) & 0xff] ^ (c >>> 8)
  }
  for (let i = 0; i < tail.length; i++) {
    c = CRC_TABLE[(c ^ tail[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 比较新旧密文，返回第一处差异的 offset。
 * 完全相同时返回 -1。
 */
export function diffOffset(previous: Uint8Array, next: Uint8Array): number {
  const limit = Math.min(previous.length, next.length)
  let i = 0
  // 8 字节一组快速跳过相同的头部
  while (i + 8 <= limit) {
    if (
      previous[i] !== next[i] ||
      previous[i + 1] !== next[i + 1] ||
      previous[i + 2] !== next[i + 2] ||
      previous[i + 3] !== next[i + 3] ||
      previous[i + 4] !== next[i + 4] ||
      previous[i + 5] !== next[i + 5] ||
      previous[i + 6] !== next[i + 6] ||
      previous[i + 7] !== next[i + 7]
    ) {
      break
    }
    i += 8
  }
  while (i < limit && previous[i] === next[i]) {
    i += 1
  }
  // 前缀完全相同时，较长的那个从 length 开始就是新增内容
  return i === previous.length && previous.length === next.length ? -1 : i
}
// ---------- 增量友好的序列化 ----------

/**
 * JSON.stringify 按对象插入顺序输出。会话对象里 messages 通常在中间，
 * 追加一条消息会让它后面的字段（rootMessageId 等）整体位移，diff 从中间开始，
 * 20MB 的会话就要重传一半。
 *
 * 这里把 messages 挪到序列化结果的最末尾：前面是 id/title/createdAt/updatedAt，
 * 于是「尾部追加消息」= 前缀完全不变 + 末尾从 ]} 变成 ,...]}，
 * diff 只剩最后几十字节，配合流式加密即可真正增量上传。
 */
export function serializeForSync(value: Record<string, unknown>): string {
  const { messages, updatedAt, title, ...rest } = value as {
    messages?: unknown[]
    updatedAt?: number
    title?: string
  } & Record<string, unknown>
  if (!Array.isArray(messages)) {
    return JSON.stringify(value)
  }
  /*
   * 字段顺序直接决定 diff 的大小，这里按「稳定 → 易变」排：
   *   1. rest：id / createdAt / rootMessageId 等创建后不再变化的字段
   *   2. messages：只在末尾追加（编辑中间某条时会从该条开始 diff，属预期）
   *   3. title + updatedAt：每次保存都会变，放最后，改标题也只影响尾部几十字节
   * 时间戳是数字，位数变化会让其后的字节全部位移，所以不能放在中间。
   */
  const head = JSON.stringify(rest)
  const body = head.slice(0, -1)
  const separator = body.length > 1 ? ',' : ''
  const tailParts: string[] = []
  if (typeof title === 'string') {
    tailParts.push('"title":' + JSON.stringify(title))
  }
  if (typeof updatedAt === 'number') {
    tailParts.push('"updatedAt":' + updatedAt)
  }
  const tail = tailParts.length > 0 ? ',' + tailParts.join(',') : ''
  return body + separator + '"messages":' + JSON.stringify(messages) + tail + '}'
}

export const deserializeForSync = <T>(text: string): T => JSON.parse(text) as T