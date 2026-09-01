import { buildApp } from './app.js'
import { runCli } from './cli/index.js'
import { closeAllStreams } from './core/bus.js'
import { stopAll } from './core/recorder.js'
import { ghostHome } from './storage/index.js'

const PORT = Number(process.env.GHOSTFRAME_PORT ?? 7331)
const HOST = process.env.GHOSTFRAME_HOST ?? '127.0.0.1'
const serveStatic = process.env.GHOSTFRAME_SERVE_STATIC !== '0'

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2))
  if (exitCode !== null) {
    process.exit(exitCode)
  }

  const app = await buildApp({ serveStatic })
  await app.listen({ port: PORT, host: HOST })

  process.stdout.write(
    `\nGhostFrame running at:\n  http://${HOST}:${PORT}\n\nData directory: ${ghostHome()}\nNo account · No cloud · No telemetry\n\n`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      // A second Ctrl-C means "stop asking nicely".
      process.exit(130)
    }
    shuttingDown = true
    process.stdout.write(`\nReceived ${signal}, stopping recorders…\n`)

    // Never let shutdown hang: a stuck watcher or socket must not keep the
    // port bound after the user asked us to stop.
    const forceExit = setTimeout(() => {
      process.stdout.write('Shutdown took too long — exiting anyway.\n')
      process.exit(0)
    }, 5000)
    forceExit.unref()

    try {
      closeAllStreams()
      await stopAll()
      await app.close()
    } finally {
      clearTimeout(forceExit)
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  console.error('GhostFrame failed to start:', err)
  process.exit(1)
})
