import type { Session } from './types.js'

/**
 * 存储层与同步引擎之间的回调挂载点：由同步引擎在启动时注册，
 * 使 db.ts 不必反向依赖 syncEngine（避免循环引用）；未解锁时回调为空，写入静默丢弃。
 */
type Hooks = {
  onSaved: (cid: string) => void
  onDeleted: (cid: string) => void
  onPulled: (session: Session) => Promise<void>
}

export const syncHooks: Hooks = {
  onSaved: () => {},
  onDeleted: () => {},
  onPulled: async () => {},
}

export const setSyncHooks = (hooks: Partial<Hooks>): void => {
  Object.assign(syncHooks, hooks)
}

export const clearSyncHooks = (): void => {
  syncHooks.onSaved = () => {}
  syncHooks.onDeleted = () => {}
  syncHooks.onPulled = async () => {}
}
