import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, cpSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

export interface PaperProcessServerOptions {
  java: string
  jar: string
  directory: string
  port: number
  eulaAccepted: boolean
  templateDirectory?: string
  startupTimeoutMs?: number
  stopTimeoutMs?: number
}

export class PaperProcessServer {
  readonly options: PaperProcessServerOptions
  #process?: ChildProcessWithoutNullStreams
  #output = ''
  #log?: ReturnType<typeof createWriteStream>

  constructor(options: PaperProcessServerOptions) { this.options = options }

  prepareFresh(): void {
    if (!this.options.eulaAccepted) throw new Error('Paper EULA must be explicitly accepted with MC_EULA=true')
    if (!existsSync(this.options.jar)) throw new Error(`Paper jar not found: ${this.options.jar}`)
    const resolved = path.resolve(this.options.directory)
    if (resolved.length < 10 || path.parse(resolved).root === resolved) throw new Error(`Unsafe Paper runtime directory: ${resolved}`)
    rmSync(resolved, { recursive: true, force: true })
    if (this.options.templateDirectory) {
      const template = path.resolve(this.options.templateDirectory)
      if (!existsSync(path.join(template, 'world', 'level.dat'))) throw new Error(`Paper world template is incomplete: ${template}`)
      cpSync(template, resolved, { recursive: true, force: true })
      rmSync(path.join(resolved, 'logs'), { recursive: true, force: true })
      rmSync(path.join(resolved, 'crash-reports'), { recursive: true, force: true })
    } else mkdirSync(resolved, { recursive: true })
    copyFileSync(this.options.jar, path.join(resolved, 'paper.jar'))
    writeFileSync(path.join(resolved, 'eula.txt'), 'eula=true\n', 'utf8')
    writeFileSync(path.join(resolved, 'server.properties'), properties(this.options.port), 'utf8')
  }

  async start(): Promise<void> {
    if (this.#process) throw new Error('Paper process is already owned by this manager')
    this.#output = ''
    this.#log = createWriteStream(path.join(this.options.directory, 'console.log'), { flags: 'a' })
    const child = spawn(this.options.java, ['-Xms512M', '-Xmx1536M', '-jar', 'paper.jar', '--nogui'], {
      cwd: this.options.directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.#process = child
    const capture = (chunk: Buffer) => { const text = chunk.toString('utf8'); this.#output += text; this.#log?.write(text) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    await this.#waitUntil(() => /Done \([^)]+\)! For help/u.test(this.#output), this.options.startupTimeoutMs ?? 120_000, 'Paper startup')
  }

  send(command: string): void {
    if (!this.#process || this.#process.exitCode !== null) throw new Error('Paper is not running')
    if (!command.trim() || /[\r\n\0]/.test(command)) throw new TypeError('Paper command must be one non-empty line')
    this.#process.stdin.write(`${command}\n`)
  }

  async stop(): Promise<void> {
    const child = this.#process
    if (!child) return
    if (child.exitCode === null) {
      try { child.stdin.write('stop\n') } catch { /* process already closing */ }
      if (!await this.#waitForExit(child, this.options.stopTimeoutMs ?? 60_000)) {
        child.kill('SIGTERM')
        if (!await this.#waitForExit(child, 10_000)) child.kill('SIGKILL')
      }
    }
    child.stdout.removeAllListeners(); child.stderr.removeAllListeners()
    this.#log?.end(); this.#log = undefined; this.#process = undefined
  }

  async restart(): Promise<void> { await this.stop(); await this.start() }
  output(): string { return this.#output }

  async #waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    const started = Date.now()
    while (!predicate()) {
      if (this.#process?.exitCode !== null) throw new Error(`${description} failed: Paper exited with ${this.#process?.exitCode}\n${this.#output.slice(-2_000)}`)
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${description}\n${this.#output.slice(-2_000)}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  async #waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true
    return new Promise(resolve => {
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
      const onExit = () => { clearTimeout(timer); resolve(true) }
      child.once('exit', onExit)
    })
  }
}

function properties(port: number): string {
  return [
    'server-ip=127.0.0.1', `server-port=${port}`, 'online-mode=false', 'enforce-secure-profile=false',
    'gamemode=survival', 'difficulty=easy', 'spawn-protection=0', 'allow-nether=true', 'enable-rcon=false',
    'view-distance=6', 'simulation-distance=4', 'max-players=4', 'motd=MineIntent ephemeral Paper CI',
  ].join('\n') + '\n'
}
