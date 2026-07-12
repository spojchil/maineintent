import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PaperProcessServer } from './paper-process-server.js'

test('Paper process manager requires explicit EULA acceptance', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mineintent-paper-'))
  try {
    const jar = path.join(root, 'paper.jar'); writeFileSync(jar, 'jar')
    const server = new PaperProcessServer({ java: 'java', jar, directory: path.join(root, 'runtime'), port: 25566, eulaAccepted: false })
    assert.throws(() => server.prepareFresh(), /EULA/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Paper process manager copies a world template without carrying old diagnostics', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mineintent-paper-'))
  try {
    const jar = path.join(root, 'paper.jar'); writeFileSync(jar, 'jar')
    const template = path.join(root, 'template'); mkdirSync(path.join(template, 'world'), { recursive: true })
    mkdirSync(path.join(template, 'logs')); writeFileSync(path.join(template, 'world', 'level.dat'), 'level'); writeFileSync(path.join(template, 'logs', 'old.log'), 'old')
    const runtime = path.join(root, 'runtime')
    new PaperProcessServer({ java: 'java', jar, templateDirectory: template, directory: runtime, port: 25566, eulaAccepted: true }).prepareFresh()
    assert.equal(readFileSync(path.join(runtime, 'world', 'level.dat'), 'utf8'), 'level')
    assert.equal(existsSync(path.join(runtime, 'logs')), false)
    assert.match(readFileSync(path.join(runtime, 'server.properties'), 'utf8'), /server-ip=127\.0\.0\.1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
