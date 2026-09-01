import type { FastifyInstance } from 'fastify'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])

function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  // Strip the port, keeping bracketed IPv6 literals intact.
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim())
  return m ? m[1].toLowerCase() : null
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The daemon binds to loopback, but that alone does not make it private: any
 * page the user visits can issue cross-origin requests to 127.0.0.1, and DNS
 * rebinding can make an attacker-controlled name resolve there. Since the API
 * can run shell commands and rewrite files, both are worth closing.
 *
 * A deliberate non-goal: this does not defend against another process running
 * as the same user. That process can already do everything GhostFrame can, so a
 * token in a file it could simply read would buy nothing.
 */
export function registerGuard(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url.startsWith('/api/')) return done()

    // DNS rebinding: the browser resolved some other name to 127.0.0.1, so the
    // Host header is not one of ours.
    const host = hostname(req.headers.host)
    if (host !== null && !LOCAL_HOSTNAMES.has(host)) {
      reply.code(403).send({ error: 'GhostFrame only accepts requests addressed to localhost.' })
      return
    }

    // Cross-site requests from a page the user happens to have open. Non-browser
    // clients (the CLI, curl, tests) send no Origin and are unaffected.
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== 'null' && !isLocalOrigin(origin)) {
      reply.code(403).send({ error: `Cross-origin requests are not allowed (origin: ${origin}).` })
      return
    }

    done()
  })
}
