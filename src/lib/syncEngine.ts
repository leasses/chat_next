/**
 * 流式加密增量同步引擎。
 *
 * 明文由 IndexedDB 维护，引擎只做四件事：加密 → diff → 校验 → 同步。
 *
 * 发送端：
 *   1. 会话落盘时重算完整密文（确定性流密码，同 offset 同密文）
 *   2. 与本地密文基线逐字节比较，找到第一个差异 offset
 *   3. 从 off 开始截取新密文作为 diff，附上合并后的 CRC32 与总长度
 *   4. 上传 {cid, ts, off, diff, crc, len}，更新本地基线
 *
 * 接收端（Realtime 推送 + 首屏拉取）：
 *   1. 收到 diff，按 ts 排序，丢弃 ≤ 本地 ts 的过期/乱序记录
 *   2. 本地密文 = baseline.slice(0, off) + diff
 *   3. 校验长度与 CRC32
 *   4. 通过则解密 → 落 IndexedDB + 更新基线 → 通知 UI
 *
 * 冲突：CRC 失败、长度不匹配、off 超出本地长度 → 丢弃该 diff，向服务器请求全量。
 *
 * 只有「激活」的会话（用户在里面发过消息）才同步；导入的历史包永久留在本地。
 */
import {
  decryptBytes,
  encryptBytes,
  encode,
  decode,
  fromBase64,
  toBase64,
  crc32,
  diffOffset,
  deriveConversationKey,
  serializeForSync,
  deserializeForSync,
} from './streamcipher.js'
import * as db from '../services/chat/db.js'
import {
  listConversations,
  upsertConversation,
  deleteConversationByCid,
  createDiff,
  listAllDiffs,
  deleteDiffsByCid,
  pb,
  currentUser,
  type DiffRecord,
  fromDeltaFrom,
} from './pb.js'
import { setSyncHooks, clearSyncHooks } from '../services/chat/syncHooks.js'
import type { Session } from '../services/chat/types.js'

/** 推送节流：用户连续输入时合并成一次上传 */
const PUSH_DELAY = 1200
/** 首屏兜底轮询：Realtime 断线时仍能收敛；连上后自动退化为低频 */
const POLL_INTERVAL = 30_000
/** 会话列表摘要的刷新间隔（有新 diff 时才真正刷新） */
const CURSOR_PREFIX = 'chat-demo:diffs-cursor:'

let userId: string | null = null
let masterKey: CryptoKey | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let visHandler: (() => void) | null = null
let unsubscribers: (() => void)[] = []
let flushing = false
let realtimeConnected = false
/** 每个会话的派生密钥缓存（解锁期间有效，锁定即清空） */
const convKeys = new Map<string, CryptoKey>()
/** 待推送：cid -> 计划推送时间 */
let outbox = new Map<string, number>()
/** 本次解锁期间被激活（用户发过消息）的会话 */
const activated = new Set<string>()
/** 会话推送连续失败次数，用于退避 */
const pushFailures = new Map<string, number>()

const listeners = new Set<() => void>()

export function onRemoteChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const notify = () => {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      // 回调异常不影响同步
    }
  }
}

/** 当前解锁密钥（仅内存；secretSync 等模块复用） */
export function getKey(): CryptoKey | null {
  return masterKey
}

// ---------- 会话密钥 ----------

async function keyFor(cid: string): Promise<CryptoKey> {
  if (!masterKey) {
    throw new Error('sync locked')
  }
  const cached = convKeys.get(cid)
  if (cached) {
    return cached
  }
  const key = await deriveConversationKey(masterKey, cid)
  convKeys.set(cid, key)
  return key
}

// ---------- 游标 ----------

const cursorKey = (uid: string) => CURSOR_PREFIX + uid
const loadCursor = (uid: string): number => {
  try {
    return Number(localStorage.getItem(cursorKey(uid)) ?? 0) || 0
  } catch {
    return 0
  }
}
const saveCursor = (uid: string, value: number) => {
  try {
    localStorage.setItem(cursorKey(uid), String(value))
  } catch {
    // 存储不可用时下次全量
  }
}
let cursor = 0

// ---------- 推送 ----------

/**
 * 本地落盘后调用。只有激活的会话才会走到这里（由 store 在「首次发送」后激活）。
 * 未激活或未解锁时静默忽略。
 */
export function enqueueSession(cid: string): void {
  // eslint-disable-next-line no-console
  if (!userId || !masterKey) {
    return
  }
  outbox.set(cid, Date.now())
  schedulePush()
}

/** 立即推送（一轮对话结束时调用，跳过防抖延迟） */
export function flushNow(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  void flushOutbox()
}

function schedulePush(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
  }
  pushTimer = setTimeout(() => {
    pushTimer = null
    void flushOutbox()
  }, PUSH_DELAY)
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

/** 推送队列：逐会话算密文 → diff → 上传 */
export async function flushOutbox(): Promise<void> {
  // eslint-disable-next-line no-console
  if (flushing || !userId || !masterKey || !visible()) {
    return
  }
  flushing = true
  let retry = false
  try {
    for (const cid of [...outbox.keys()]) {
      outbox.delete(cid)
      try {
        await pushOne(cid)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[sync] push failed', cid, error)
        // 失败重试一次即可，避免持续失败时「待上传」永远不消失且疯狂请求
        const attempts = (pushFailures.get(cid) ?? 0) + 1
        pushFailures.set(cid, attempts)
        if (attempts <= 2) {
          outbox.set(cid, Date.now())
          retry = true
        } else {
          // 放弃本轮，交给下一次编辑或重连时再试
          pushFailures.delete(cid)
        }
      }
    }
    if (retry || outbox.size > 0) {
      schedulePush()
    }
  } finally {
    flushing = false
  }
}

/**
 * 推送一个会话：首次（无基线）上传全量密文，之后只上传增量。
 * 这是唯一的写入路径——activateSession 只做标记与入队，不直接上传。
 */
async function pushOne(cid: string): Promise<void> {
  const current = userId
  if (!current) {
    return
  }
  const session = await db.loadSession(cid)
  if (!session) {
    return
  }
  // 只同步用户实际聊过的会话：导入的历史包永远留在本地
  if (!session.messages.some((message) => message.role === 'user')) {
    return
  }

  const baseline = await db.loadBaseline(cid)
  // 没有基线且从未被激活 → 不参与同步
  if (!baseline && !activated.has(cid)) {
    return
  }

  const key = await keyFor(cid)
  const cipher = await encryptBytes(
    key,
    encode(serializeForSync(session as unknown as Record<string, unknown>))
  )
  const crc = crc32(cipher)

  if (!baseline) {
    // 首次：上传全量密文，作为后续增量与其它设备兜底重建的起点
    const ts = Date.now()
    await upsertConversation(current, cid, toBase64(cipher), ts)
    await db.saveBaseline({ id: cid, cipher, ts, crc })
    pushFailures.delete(cid)
    return
  }

  const off = diffOffset(baseline.cipher, cipher)
  if (off === -1) {
    // 密文未变（例如只动了 UI 状态），不需要上传
    return
  }

  // 时间戳严格递增，接收端据此丢弃乱序或过期记录
  const ts = Math.max(Date.now(), baseline.ts + 1)
  await createDiff({
    userId: current,
    cid,
    ts,
    off,
    diff: toBase64(cipher.subarray(off)),
    crc,
    len: cipher.length,
  })
  await db.saveBaseline({ id: cid, cipher, ts, crc })
  pushFailures.delete(cid)
}

// ---------- 应用变更 ----------

/**
 * 把一串 diff 应用到某个会话上。
 * 返回 true 表示本地数据已更新。
 */
async function applyDiffs(cid: string, records: DiffRecord[]): Promise<boolean> {
  // eslint-disable-next-line no-console
  if (records.length === 0) {
    return false
  }
  const baseline = await db.loadBaseline(cid)
  const base = baseline?.cipher ?? new Uint8Array(0)
  // eslint-disable-next-line no-console
  let current = base
  let ts = baseline?.ts ?? 0

  for (const record of records) {
    if (record.ts <= ts) {
      continue // 过期或乱序
    }
    const diff = fromBase64(record.diff)
    const off = fromDeltaFrom(record.delta_from)
    // off 必须落在本地长度内，否则说明本地落后太多，需要全量
    if (off < 0 || off > current.length) {
      throw new ConflictError(cid)
    }
    const next = new Uint8Array(off + diff.length)
    next.set(current.subarray(0, off))
    next.set(diff, off)
    if (next.length !== record.total_len) {
      throw new ConflictError(cid)
    }
    if (crc32(next) !== record.crc >>> 0) {
      throw new ConflictError(cid)
    }
    current = next
    ts = record.ts
  }

  if (current === base) {
    return false
  }

  // 校验通过：解密 → 落库 → 更新基线 → 通知 UI
  const key = await keyFor(cid)
  const plain = await decryptBytes(key, current)
  const session = deserializeForSync<Session>(decode(plain))
  await db.savePulledWithBaseline(session, { id: cid, cipher: current, ts, crc: crc32(current) })
  return true
}

class ConflictError extends Error {
  constructor(readonly cid: string) {
    super('diff conflict: ' + cid)
  }
}

/** 冲突兜底：向服务器要全量密文，重建基线 */
async function resyncFull(cid: string): Promise<void> {
  if (!userId) {
    return
  }
  const records = await listConversations(userId, 0)
  const rec = records.find((item) => item.conversation_id === cid)
  if (!rec) {
    return
  }
  const key = await keyFor(cid)
  const cipher = fromBase64(rec.cipher)
  const plain = await decryptBytes(key, cipher)
  const session = deserializeForSync<Session>(decode(plain))
  await db.savePulledWithBaseline(session, {
    id: cid,
    cipher,
    ts: rec.rev,
    crc: crc32(cipher),
  })
}

const activeIds = async (): Promise<Set<string>> =>
  new Set((await db.loadSessionSummaries()).map((s) => s.id))

/** 处理一批远端记录（可能涉及多个会话） */
async function applyRecords(records: DiffRecord[]): Promise<void> {
  const known = await activeIds()
  let changed = false
  const byCid = new Map<string, DiffRecord[]>()
  for (const record of records) {
    cursor = Math.max(cursor, record.ts)
    // 本地没有这个会话：别的设备新建的，拉一次全量并在通知后刷新列表
    if (!known.has(record.cid)) {
      try {
        await resyncFull(record.cid)
        changed = true
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[sync] new session resync failed', record.cid, error)
      }
      continue
    }
    const list = byCid.get(record.cid) ?? []
    list.push(record)
    byCid.set(record.cid, list)
  }

  for (const [cid, list] of byCid) {
    list.sort((a, b) => a.ts - b.ts)
    try {
      if (await applyDiffs(cid, list)) {
        changed = true
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[sync] apply diffs failed', cid, error)
      if (error instanceof ConflictError) {
        // eslint-disable-next-line no-console
        try {
          await resyncFull(cid)
          changed = true
        } catch (resyncError) {
          // eslint-disable-next-line no-console
          console.error('[sync] resync failed', cid, resyncError)
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('[sync] apply failed', cid, error)
      }
    }
  }
  if (changed) {
    notify()
  }
}

/** 兜底轮询：只取增量，Realtime 正常时几乎无变化 */
async function poll(): Promise<void> {
  if (!userId || !masterKey || !visible()) {
    return
  }
  try {
    const records = await listAllDiffs(userId, cursor)
    await applyRecords(records)
    saveCursor(userId, cursor)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[sync] poll failed', error)
  }
}

// ---------- Realtime ----------

/** 订阅 diffs 集合：服务端主动推变更，只推元数据（不含正文） */
async function subscribeRealtime(): Promise<void> {
  if (!userId) {
    return
  }
  try {
    const unsubscribe = await pb.collection('diffs').subscribe<DiffRecord>('*', (event) => {
      const record = event.record as unknown as DiffRecord
      // eslint-disable-next-line no-console
      if (!record || record.user !== userId) {
        return
      }
      if (event.action === 'delete') {
        return
      }
      const owner = userId
      if (!owner) {
        return
      }
      void (async () => {
        try {
          await applyRecords([record])
          saveCursor(owner, cursor)
          // 无论走 diff 还是全量兜底，都通知 UI 重新读一次
          notify()
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('[sync] realtime apply failed', error)
        }
      })()
    })
    unsubscribers.push(unsubscribe)
    // conversations 的全量记录也要订阅：新会话首次上传、以及 diff 缺失时的兜底全靠它
    const unsubscribeConv = await pb.collection('conversations').subscribe('*', (event) => {
      const record = event.record as unknown as { conversation_id?: string; user?: string; rev?: number }
      if (!record || record.user !== userId || !record.conversation_id) {
        return
      }
      const cid = record.conversation_id
      void (async () => {
        const local = await db.loadBaseline(cid)
        // 本地没有基线，或远端版本更新 → 拉全量重建
        if (!local || local.ts < (record.rev ?? 0)) {
          await resyncFull(cid)
          notify()
        }
      })().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[sync] conversation push failed', error)
      })
    })
    unsubscribers.push(unsubscribeConv)
    realtimeConnected = true
  } catch (error) {
    realtimeConnected = false
    // eslint-disable-next-line no-console
    console.warn('[sync] realtime unavailable, fallback to polling', error)
  }
}

// ---------- 生命周期 ----------

/**
 * 启动同步。用最新一条记录做解密探针校验密码是否正确。
 * 返回失败原因供界面提示。
 */
export async function start(
  uid: string,
  key: CryptoKey
): Promise<{ ok: boolean; reason?: 'decrypt' | 'network' }> {
  stop()
  userId = uid
  masterKey = key
  cursor = loadCursor(uid)

  try {
    const records = await listConversations(uid, 0)
    if (records.length > 0) {
      const newest = [...records].sort((a, b) => b.rev - a.rev)[0]
      try {
        // 探针：密码不对时解密必然失败
        await decryptBytes(await keyFor(newest.conversation_id), fromBase64(newest.cipher))
      } catch {
        return { ok: false, reason: 'decrypt' }
      }
    }
    // 首屏：把所有增量按会话基线重建一次
    await applyRecords(await listAllDiffs(uid, 0))
    saveCursor(uid, cursor)
    // 本地没有基线的会话（新设备/换设备）从全量密文重建；
    // 有基线但 rev 更新的，说明错过了增量，也重建一次
    for (const rec of records) {
      const local = await db.loadBaseline(rec.conversation_id)
      if (!local || local.ts < rec.rev) {
        await resyncFull(rec.conversation_id).catch(() => {})
      }
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[sync] initial pull failed', error)
    return { ok: false, reason: 'network' }
  }

  // eslint-disable-next-line no-console
  await subscribeRealtime()
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL)
  visHandler = () => {
    if (visible()) {
      void flushOutbox()
      void poll()
    }
  }
  document.addEventListener('visibilitychange', visHandler)

  setSyncHooks({
    onSaved: (cid: string) => enqueueSession(cid),
    onDeleted: (cid: string) => deleteRemoteSession(cid),
    onPulled: async () => {
      // 拉取统一走 diff 链路，这里保留给未来扩展
    },
  })
  return { ok: true }
}

/** 停止同步并清空内存密钥 */
export function stop(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (visHandler) {
    document.removeEventListener('visibilitychange', visHandler)
    visHandler = null
  }
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe()
    } catch {
      // 忽略重复退订
    }
  }
  unsubscribers = []
  if (pb.authStore.isValid) {
    void pb.collection('diffs').unsubscribe('*').catch(() => {})
  }
  clearSyncHooks()
  convKeys.clear()
  activated.clear()
  pushFailures.clear()
  outbox = new Map()
  userId = null
  masterKey = null
  cursor = 0
  flushing = false
  realtimeConnected = false
}

/** 本地删除会话：清远端全量密文与整条增量链 */
export function deleteRemoteSession(cid: string): void {
  if (!userId) {
    return
  }
  outbox.delete(cid)
  convKeys.delete(cid)
  const uid = userId
  void (async () => {
    await deleteDiffsByCid(uid, cid)
    await deleteConversationByCid(uid, cid)
  })().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[sync] delete remote failed', error)
  })
}

/** 供设置页显示同步状态 */
export const syncState = {
  get realtime(): boolean {
    return realtimeConnected
  },
  get pending(): number {
    return outbox.size
  },
}

/** 激活会话：首次发送消息时调用，之后才参与同步 */
/** 激活会话：用户在其中发过消息后调用，此后参与云端同步 */
export function activateSession(cid: string): void {
  if (!userId || !masterKey) {
    return
  }
  activated.add(cid)
  enqueueSession(cid)
  flushNow()
}

/** 兼容旧调用：确保 user 记录存在时可用 */
export const currentSyncUser = (): string | null => currentUser()?.id ?? null