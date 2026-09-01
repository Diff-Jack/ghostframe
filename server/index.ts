import { buildApp } from './app.js'
import { stopAll } from './core/recorder.js'
import { ghostHome } from './storage/index.js'

const PORT = Number(process.env.GHOSTFRAME_PORT ?? 7331)
const HOST = process.env.GHOSTFRAME_HOST ?? '127.0.0.1'
const serveStatic = process.env.GHOSTFRAME_SERVE_STATIC !== '0'

async function main(): Promise<void> {
  const app = await buildApp({ serveStatic })
  await app.listen({ port: PORT, host: HOST })

  process.stdout.write(
    `\nGhostFrame running at:\n  http://${HOST}:${PORT}\n\nData directory: ${ghostHome()}\nNo account · No cloud · No telemetry\n\n`,
  )

  const shutdown = async (signal: string) => {
    process.stdout.write(`\nReceived ${signal}, stopping recorders…\n`)
    await stopAll()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error('GhostFrame failed to start:', err)
  process.exit(1)
})
