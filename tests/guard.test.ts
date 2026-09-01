import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { cleanup, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let app: FastifyInstance
let home: string
let repo: string

beforeAll(async () => {
  home = await makeTempHome('guard')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('guard')
  const { buildApp } = await import('../server/app.js')
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
  await cleanup(home, repo)
})

describe('local-only request guard', () => {
  it('allows a request with no Origin (CLI, curl, tests)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
  })

  it('allows the dev-server origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { origin: 'http://localhost:7330' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('allows a loopback IP origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { origin: 'http://127.0.0.1:7331' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('blocks a cross-site page trying to drive the API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { origin: 'https://evil.example.com' },
      payload: { repoPath: repo },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('Cross-origin')
  })

  it('blocks a cross-site page from running shell commands', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run_whatever/shell',
      headers: { origin: 'http://attacker.local' },
      payload: { command: 'rm -rf /' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('blocks DNS rebinding via a non-local Host header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { host: 'rebind.attacker.com:7331' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toContain('localhost')
  })

  it('accepts a localhost Host header with a port', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { host: '127.0.0.1:7331' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('does not gate non-API routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    })
    // /api/health is still under /api/, so it is guarded too — by design.
    expect(res.statusCode).toBe(403)
  })
})
