import path from 'node:path'
import fsSync from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { isLocalOrigin, registerGuard } from './api/guard.js'
import { registerRoutes } from './api/routes.js'
import { ensureLayout } from './storage/index.js'
import { reconcileOnStartup } from './core/recorder.js'

export interface BuildOptions {
  /** Serve the built UI from dist/web. Off in tests and in `npm run dev`. */
  serveStatic?: boolean
  logger?: boolean
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  await ensureLayout()
  await reconcileOnStartup()

  const app = Fastify({
    logger: opts.logger ? { transport: undefined } : false,
    bodyLimit: 32 * 1024 * 1024,
    // Without this a lingering keep-alive socket also stalls shutdown.
    forceCloseConnections: true,
  })

  // CORS is scoped to loopback so `vite dev` on :7330 can reach the API on
  // :7331, without also handing every website the user visits an open door.
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || isLocalOrigin(origin)),
  })
  registerGuard(app)
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } })

  await registerRoutes(app)

  if (opts.serveStatic) {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // dist/server/app.js -> dist/web
    const candidates = [
      path.resolve(here, '../web'),
      path.resolve(here, '../../dist/web'),
    ]
    const webRoot = candidates.find((p) => fsSync.existsSync(path.join(p, 'index.html')))
    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot })
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) {
          return reply.code(404).send({ error: `No such endpoint: ${req.url}` })
        }
        return reply.sendFile('index.html')
      })
    } else {
      app.log?.warn?.('UI bundle not found — run `npm run build:web`.')
    }
  }

  return app
}
