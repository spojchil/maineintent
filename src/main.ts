import { loadEnvFile } from 'node:process'
import { MineIntentApp, loadAppConfig } from './app/index.js'

try { loadEnvFile() } catch (error) {
  if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error
}

const app = new MineIntentApp(loadAppConfig())
const { debugUrl } = await app.start()
console.log(`MineIntent 已启动；只读调试状态：${debugUrl}`)

let stopping = false
const stop = async (reason: string) => {
  if (stopping) return
  stopping = true
  console.log(`正在停止 MineIntent（${reason}）…`)
  await app.stop(reason)
}
process.once('SIGINT', () => { void stop('SIGINT').then(() => process.exit(0)) })
process.once('SIGTERM', () => { void stop('SIGTERM').then(() => process.exit(0)) })
