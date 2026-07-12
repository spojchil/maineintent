import type { BackendEventEnvelope, ProtocolChatEvent } from '../minecraft/contracts.js'
import type { ChatInputContext, PlayerChatMessage } from './contracts.js'

const STOP_ZH = /^(?:请)?(?:你)?(?:先)?(?:停下|停一下|别动|不要动|停止|住手)(?:吧|！|!|。|\.)?$/u
const STOP_EN = /^(?:please\s+)?(?:stop|hold on|wait|freeze)(?:\s+now)?[!.]?$/iu
const AMBIGUOUS_PREFIX = /^(?:如果|要是|假如|when|if|unless|等.+再)/iu

export function interpretPlayerChat(
  event: BackendEventEnvelope<ProtocolChatEvent>,
  context: ChatInputContext,
): PlayerChatMessage | undefined {
  if (event.kind !== 'chat' || event.payload.position !== 'chat' || !event.payload.senderUsername) return undefined
  const sender = event.payload.senderUsername
  const isPrimaryPlayer = context.primaryPlayerUsernames.some(name => equalName(name, sender))
  const explicitName = mentionsName(event.payload.plainText, context.companionUsername)
  const ongoing = equalName(context.conversationActiveWith, sender)
  const singleParty = isPrimaryPlayer && context.onlinePlayerUsernames.filter(name => !equalName(name, context.companionUsername)).length === 1
  const evidence = [
    ...(explicitName ? ['explicit_name' as const] : []),
    ...(ongoing ? ['ongoing_conversation' as const] : []),
    ...(singleParty ? ['primary_player_single_party' as const] : []),
  ]
  const addressed = evidence.length > 0
  return {
    protocol: 'mineintent.player-chat.v1',
    sourceEventId: event.id,
    occurredAt: event.occurredAt,
    sender: { username: sender, isPrimaryPlayer },
    text: event.payload.plainText,
    ...(event.payload.verified === undefined ? {} : { verified: event.payload.verified }),
    addressing: { addressedToCompanion: addressed, evidence: evidence.length ? evidence : ['not_addressed'] },
    controlIntent: isPrimaryPlayer && addressed && isUnambiguousSafetyStop(event.payload.plainText, context.companionUsername)
      ? 'safety_stop' : 'none',
    world: { worldId: event.worldId, ...(event.dimension ? { dimension: event.dimension } : {}), connectionEpoch: event.connectionEpoch },
  }
}

export function isUnambiguousSafetyStop(text: string, companionUsername?: string): boolean {
  let normalized = text.trim().replace(/^[@＠]/u, '')
  if (companionUsername && mentionsName(normalized, companionUsername)) {
    normalized = normalized.replace(new RegExp(`^${escapeRegex(companionUsername)}[，,:：\s]*`, 'iu'), '').trim()
  }
  if (AMBIGUOUS_PREFIX.test(normalized) || /[“”"']/.test(normalized)) return false
  return STOP_ZH.test(normalized) || STOP_EN.test(normalized)
}

function equalName(a: string | undefined, b: string): boolean { return a?.toLocaleLowerCase() === b.toLocaleLowerCase() }
function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(?:^|[@＠\\s，,：:])${escapeRegex(name)}(?:$|[\\s，,：:！!.?？])`, 'iu').test(text)
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
