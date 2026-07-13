import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface CompanionProfile {
  profileId: string
  versionId: string
  content: string
  sourcePath: string
}

export async function loadCompanionProfile(file: string): Promise<CompanionProfile> {
  const sourcePath = path.resolve(file)
  const content = (await readFile(sourcePath, 'utf8')).trim()
  if (!content || Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new Error('Companion profile must contain 1-65536 UTF-8 bytes')
  const profileId = path.basename(file, path.extname(file)).replace(/[^a-z0-9_-]+/giu, '-').toLocaleLowerCase() || 'companion'
  const versionId = createHash('sha256').update(content).digest('hex').slice(0, 16)
  return { profileId, versionId, content, sourcePath }
}
