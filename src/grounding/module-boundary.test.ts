import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const groundingRoot = dirname(fileURLToPath(import.meta.url))
const importPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g

test('Grounding depends on information contracts, not providers or client implementations', async () => {
  const violations: string[] = []
  for (const file of await typescriptFiles(groundingRoot)) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!
      if (specifier.includes('/information/providers/') || specifier.includes('/minecraft/') ||
          specifier.includes('/motor/') || specifier === 'mineflayer') {
        violations.push(`${relative(groundingRoot, file)} -> ${specifier}`)
      }
    }
  }
  assert.deepEqual(violations, [])
})

async function typescriptFiles(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await typescriptFiles(path))
    else if (extname(entry.name) === '.ts') result.push(path)
  }
  return result
}
