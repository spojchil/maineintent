import { z } from 'zod'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u

export interface D40ToolInvocation {
  runId: string
  name: string
  arguments: unknown
}

export const d40ToolInvocationSchema = z.strictObject({
  runId: z.string().regex(RUN_ID),
  name: z.string().regex(TOOL_NAME),
  arguments: z.json(),
})

export type D40ToolHandler = (invocation: D40ToolInvocation) => Promise<unknown>

export interface D40ToolBridgeAddress {
  host: '127.0.0.1'
  port: number
  /** Complete callback URL consumed by agent-service, including the experimental route. */
  url: string
  /** Per-process bearer credential. It must never be exposed to the model or logs. */
  token: string
}
