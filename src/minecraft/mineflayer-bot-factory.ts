import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import type { BotLike, MineflayerBotFactory, SafeBotOptions } from './internal.js'

export class DefaultMineflayerBotFactory implements MineflayerBotFactory {
  create(options: SafeBotOptions): BotLike {
    const bot = mineflayer.createBot(options)
    bot.loadPlugin(pathfinder)
    return bot as unknown as BotLike
  }
}
