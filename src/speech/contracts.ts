export type AddressingEvidence =
  | 'explicit_name'
  | 'explicit_reply'
  | 'primary_player_single_party'
  | 'ongoing_conversation'
  | 'not_addressed'

export interface PlayerChatMessage {
  protocol: 'mineintent.player-chat.v1'
  sourceEventId: string
  occurredAt: string
  sender: { username: string; isPrimaryPlayer: boolean }
  text: string
  verified?: boolean
  addressing: { addressedToCompanion: boolean; evidence: AddressingEvidence[] }
  controlIntent: 'safety_stop' | 'none'
  world: { worldId: string; dimension?: string; connectionEpoch: number }
}

export interface ChatInputContext {
  companionUsername: string
  primaryPlayerUsernames: readonly string[]
  onlinePlayerUsernames: readonly string[]
  conversationActiveWith?: string
}

export type SpeechTiming = 'now' | 'after_actions_accepted' | 'after_action_terminal'
export type SpeechPurpose = 'reply' | 'acknowledge' | 'coordinate' | 'report' | 'social' | 'ask'

export interface SpeechRequest {
  id: string
  text: string
  timing: SpeechTiming
  purpose: SpeechPurpose
  dependsOn?: readonly string[]
  terminalCondition?: 'completed' | 'failed' | 'cancelled' | 'any'
  urgency?: 'normal' | 'urgent'
}

export type SpeechEvent =
  | { type: 'scheduled'; requestId: string; segments: number }
  | { type: 'sent'; requestId: string; segment: number; text: string }
  | { type: 'cancelled'; requestId: string; reason: string }
  | { type: 'failed'; requestId: string; reason: string }

export interface SpeechTransport { send(message: string): void }
