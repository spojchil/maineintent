import mineflayer from 'mineflayer'
import type { BotLike, MineflayerBotFactory, SafeBotOptions } from './internal.js'

export class DefaultMineflayerBotFactory implements MineflayerBotFactory {
  create(options: SafeBotOptions): BotLike {
    return mineflayer.createBot(options) as unknown as BotLike
  }
}

