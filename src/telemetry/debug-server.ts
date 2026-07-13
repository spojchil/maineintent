import { createServer, type Server } from 'node:http'
import type { DebugStateStore } from './debug-state.js'

export interface DebugServerAddress { host: '127.0.0.1'; port: number; url: string }

export class LocalDebugServer {
  readonly #state: DebugStateStore
  readonly #port: number
  #server?: Server

  constructor(state: DebugStateStore, port = 3211) {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('Debug port must be between 0 and 65535')
    this.#state = state
    this.#port = port
  }

  async start(): Promise<DebugServerAddress> {
    if (this.#server) return this.address()
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }).end(JSON.stringify({ error: 'read_only' }))
        return
      }
      if (request.url === '/health') {
        response.writeHead(200).end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (request.url === '/v1/state') {
        response.writeHead(200).end(JSON.stringify(this.#state.snapshot()))
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }))
    })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    return this.address()
  }

  address(): DebugServerAddress {
    const address = this.#server?.address()
    if (!address || typeof address === 'string') throw new Error('Debug server is not listening')
    return { host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}` }
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
