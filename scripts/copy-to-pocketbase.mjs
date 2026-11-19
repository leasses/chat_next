/**
 * 把 dist/ 构建产物同步到 PocketBase 的静态目录 pb_public/。
 * 用法：npm run build && npm run deploy:copy
 */
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dist = path.join(root, 'dist')
const target = path.join(root, 'pocketbase', 'pb_public')

if (!existsSync(dist)) {
  console.error('找不到 dist/，请先执行 npm run build')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(dist, target, { recursive: true })
console.log('✓ 已复制 dist → pocketbase/pb_public')
console.log('  下一步：cd pocketbase && ./start.sh')
