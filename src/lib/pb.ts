/**
 * PocketBase 客户端：单例、集合类型与同步所需的最小 CRUD 封装。
 * 鉴权 token 由 SDK 存 localStorage；密码与加密密钥不落盘。
 */
import PocketBase from 'pocketbase'

// 开发时后端跑在 8091（8090 留给前端 dev server）；生产环境在登录页「服务器地址」里改成实际域名
// 默认与前端同源：生产由 PocketBase 同时托管前端与 API；
// 开发时由 rspack devServer 把 /api 代理到本地 PocketBase（见 rspack.config.ts）
const DEFAULT_URL = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8090'
const URL_KEY = 'chat-demo:pb-url'

function initialUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL
  } catch {
    return DEFAULT_URL
  }
}

export const pb = new PocketBase(initialUrl())

/** 切换后端地址（登录页可改）；会丢失当前会话状态，由调用方处理。 */
export function setPbUrl(url: string): void {
  const trimmed = url.replace(/\/+$/, '')
  try {
    localStorage.setItem(URL_KEY, trimmed)
  } catch {
    // 存储不可用时仅本次会话生效
  }
  window.location.reload()
}

export function getPbUrl(): string {
  return pb.baseUrl
}

/** users 集合上存放 KDF salt 的字段名 */
export const SALT_FIELD = 'crypto_salt'

/**
 * users.username 是 PocketBase 内置字段，格式只允许字母/数字/下划线，不能是邮箱。
 * 本应用只用邮箱登录（集合已设 allowUsernameAuth=false），所以注册时交给后端自动生成。 */

export type ConvRecord = {
  id: string
  user: string
  conversation_id: string
  rev: number
  cipher: string
}

export type SecretRecord = {
  id: string
  user: string
  cipher: string
}

export type AuthUser = {
  id: string
  email: string
  crypto_salt?: string
}

export function currentUser(): AuthUser | null {
  return pb.authStore.isValid ? (pb.authStore.record as unknown as AuthUser) : null
}

// ---------- users / salt ----------

/** 请求邮箱验证码（服务端限流：60 秒一次、同邮箱每日 10 次、同 IP 每小时 20 次） */
export async function requestEmailCode(email: string): Promise<void> {
  await pb.send('/api/verify/request', {
    method: 'POST',
    body: { email },
  })
}

export async function signUp(email: string, password: string, code: string): Promise<AuthUser> {
  // 不传 username：由 PocketBase 生成，登录只用邮箱；code 由服务端 hook 校验并摘除
  await pb.collection('users').create({
    email,
    password,
    passwordConfirm: password,
    code,
  })
  const auth = await pb.collection('users').authWithPassword(email, password)
  return auth.record as unknown as AuthUser
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const auth = await pb.collection('users').authWithPassword(email, password)
  return auth.record as unknown as AuthUser
}

export async function ensureSalt(user: AuthUser): Promise<string> {
  if (user.crypto_salt && /^[0-9a-f]{64}$/.test(user.crypto_salt)) {
    return user.crypto_salt
  }
  const { generateSalt } = await import('./crypto.js')
  const salt = generateSalt()
  await pb.collection('users').update(user.id, { [SALT_FIELD]: salt })
  pb.authStore.save(pb.authStore.token, { ...pb.authStore.record, [SALT_FIELD]: salt } as never)
  return salt
}

/** 覆写 salt（清空重建时使用） */
export async function overwriteSalt(userId: string, salt: string): Promise<void> {
  await pb.collection('users').update(userId, { [SALT_FIELD]: salt })
  pb.authStore.save(pb.authStore.token, { ...pb.authStore.record, [SALT_FIELD]: salt } as never)
}

// ---------- conversations ----------

export async function listConversations(userId: string, since: number): Promise<ConvRecord[]> {
  return (await pb.collection('conversations').getFullList({
    filter: pb.filter('user = {:user} && rev > {:since}', { user: userId, since }),
    sort: 'rev',
  })) as unknown as ConvRecord[]
}

export async function findConversation(userId: string, cid: string): Promise<ConvRecord | null> {
  const items = (await pb.collection('conversations').getList(1, 1, {
    filter: pb.filter('user = {:user} && conversation_id = {:cid}', { user: userId, cid }),
  })) as unknown as { items: ConvRecord[] }
  return items.items[0] ?? null
}

/** 按 (user, conversation_id) 幂等写入；存在则更新，否则创建。 */
export async function upsertConversation(
  userId: string,
  cid: string,
  cipher: string,
  rev: number
): Promise<void> {
  const existing = await findConversation(userId, cid)
  if (existing) {
    if (existing.rev >= rev) {
      return // 服务端已更新，跳过（拉取逻辑会取到新数据）
    }
    await pb.collection('conversations').update(existing.id, { cipher, rev })
  } else {
    await pb.collection('conversations').create({ user: userId, conversation_id: cid, cipher, rev })
  }
}

export async function deleteConversationByCid(userId: string, cid: string): Promise<void> {
  const existing = await findConversation(userId, cid)
  if (existing) {
    await pb.collection('conversations').delete(existing.id)
  }
}

// ---------- diffs（流式增量） ----------

/**
 * 增量记录。字段命名受 PocketBase 限制：
 * off 是保留字（不能用），数字字段 0 会被判为“缺省”，因此偏移存成 off+1。
 */
export type DiffRecord = {
  id: string
  user: string
  cid: string
  ts: number
  /** 实际偏移 = delta_from - 1 */
  delta_from: number
  diff: string
  crc: number
  total_len: number
}

export const toDeltaFrom = (off: number): number => off + 1
export const fromDeltaFrom = (value: number): number => value - 1

/** 拉取某会话在 since 之后的增量（按 ts 升序） */
export async function listDiffs(userId: string, cid: string, since: number): Promise<DiffRecord[]> {
  return (await pb.collection('diffs').getFullList({
    filter: pb.filter('user = {:user} && cid = {:cid} && ts > {:since}', {
      user: userId,
      cid,
      since,
    }),
    sort: 'ts',
  })) as unknown as DiffRecord[]
}

/** 拉取该用户所有会话在 since 之后的增量，用于首屏一次性对齐 */
export async function listAllDiffs(userId: string, since: number): Promise<DiffRecord[]> {
  return (await pb.collection('diffs').getFullList({
    filter: pb.filter('user = {:user} && ts > {:since}', { user: userId, since }),
    sort: 'ts',
  })) as unknown as DiffRecord[]
}

/** 写入一条增量；ts 由调用方保证单调（同一会话用 Date.now()） */
export async function createDiff(record: {
  userId: string
  cid: string
  ts: number
  off: number
  diff: string
  crc: number
  len: number
}): Promise<void> {
  await pb.collection('diffs').create({
    user: record.userId,
    cid: record.cid,
    ts: record.ts,
    delta_from: toDeltaFrom(record.off),
    diff: record.diff,
    crc: record.crc,
    total_len: record.len,
  })
}

/** 删除会话时一并清理其增量链 */
export async function deleteDiffsByCid(userId: string, cid: string): Promise<void> {
  const records = (await pb.collection('diffs').getFullList({
    filter: pb.filter('user = {:user} && cid = {:cid}', { user: userId, cid }),
    fields: 'id',
  })) as unknown as { id: string }[]
  for (const record of records) {
    await pb.collection('diffs').delete(record.id)
  }
}

// ---------- secrets (API Key 密文) ----------

export async function getSecretRecord(userId: string): Promise<SecretRecord | null> {
  const items = (await pb.collection('secrets').getList(1, 1, {
    filter: pb.filter('user = {:user}', { user: userId }),
  })) as unknown as { items: SecretRecord[] }
  return items.items[0] ?? null
}

export async function upsertSecret(userId: string, cipher: string): Promise<void> {
  const existing = await getSecretRecord(userId)
  if (existing) {
    await pb.collection('secrets').update(existing.id, { cipher })
  } else {
    await pb.collection('secrets').create({ user: userId, cipher })
  }
}

export async function deleteSecretRecord(userId: string): Promise<void> {
  const existing = await getSecretRecord(userId)
  if (existing) {
    await pb.collection('secrets').delete(existing.id)
  }
}

// ---------- 清空重建 ----------

/** 删除该用户在服务端的全部加密数据（忘记密码/重置流程用）。 */
/**
 * 清空该用户在服务端的全部同步数据（conversations + diffs + secrets）。
 * 导入/删除全部/重置密码后必须调用：否则本地已不存在的数据仍留在服务端，
 * 下一次同步会被当成「远端更新」拉回来，状态彻底错乱。
 *
 * keepSecret=true 时保留 secrets（仅换掉聊天数据，Key 不动）。
 */
export async function wipeServerData(
  userId: string,
  options: { keepSecret?: boolean } = {}
): Promise<void> {
  // 先删增量再删全量：diff 依赖 conversation，顺序反了会残留孤儿记录
  const diffs = (await pb.collection('diffs').getFullList({
    filter: pb.filter('user = {:user}', { user: userId }),
    fields: 'id',
  })) as unknown as { id: string }[]
  for (const rec of diffs) {
    await pb.collection('diffs').delete(rec.id)
  }

  for (const rec of await listConversations(userId, 0)) {
    await pb.collection('conversations').delete(rec.id)
  }

  if (!options.keepSecret) {
    await deleteSecretRecord(userId)
  }
}