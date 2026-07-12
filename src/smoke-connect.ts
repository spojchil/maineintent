import mineflayer from 'mineflayer'

const host = process.env.MC_HOST ?? 'localhost'
const port = Number(process.env.MC_PORT ?? '25565')
const username = process.env.MC_USERNAME ?? 'MineIntentBot'

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  version: '1.21.1',
})

const timeout = setTimeout(() => {
  console.error('Connection timed out after 15 seconds.')
  bot.end('Smoke test timed out')
  process.exitCode = 1
}, 15_000)

bot.once('spawn', () => {
  clearTimeout(timeout)
  console.log(JSON.stringify({
    status: 'connected',
    username: bot.username,
    version: bot.version,
    position: bot.entity.position.toArray(),
    health: bot.health,
    food: bot.food,
    gameMode: bot.game.gameMode,
    dimension: bot.game.dimension,
  }, null, 2))
  bot.quit('Smoke test completed')
})

bot.on('kicked', (reason) => {
  clearTimeout(timeout)
  console.error('Kicked:', reason)
  process.exitCode = 1
})

bot.on('error', (error) => {
  clearTimeout(timeout)
  console.error('Connection error:', error)
  process.exitCode = 1
})
