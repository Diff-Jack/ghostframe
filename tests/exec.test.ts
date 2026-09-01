import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { RunDetail } from '../shared/types.js'
import { cleanup, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let app: FastifyInstance
let repo: string
let home: string
let runId: string

const detail = async () => (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json() as RunDetail

beforeAll(async () => {
  home = await makeTempHome('exec')
  process.env.GHOSTFRAME_HOME = home
  process.env.GHOSTFRAME_DEBOUNCE_MS = '300'
  repo = await makeTempRepo('exec')
  const { buildApp } = await import('../server/app.js')
  app = await buildApp()
  runId = (await app.inject({ method: 'POST', url: '/api/runs', payload: { repoPath: repo } })).json().run.id
})

afterAll(async () => {
  const { stopAll } = await import('../server/core/recorder.js')
  await stopAll()
  await app?.close()
  await cleanup(home, repo)
})

describe('record-shell (the ghostframe exec endpoint)', () => {
  it('files an already-executed command as a shell event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/record-shell`,
      payload: { command: 'echo hi', stdout: 'hi\n', stderr: '', exitCode: 0, durationMs: 12 },
    })
    expect(res.statusCode).toBe(200)
    const event = res.json().event
    expect(event.type).toBe('shell')
    expect(event.exitCode).toBe(0)
    expect(event.stdout).toBe('hi\n')
    expect(event.durationMs).toBe(12)
  })

  it('classifies a known test runner as a test event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/record-shell`,
      payload: { command: 'pnpm test', stdout: '', stderr: 'boom', exitCode: 1 },
    })
    expect(res.json().event.type).toBe('test')
    expect(res.json().event.exitCode).toBe(1)
  })

  it('feeds first-bad-change detection', async () => {
    // A passing run, an edit, then a failing run.
    await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/record-shell`,
      payload: { command: 'npm test', exitCode: 0 },
    })
    await fs.writeFile(path.join(repo, 'src.txt'), 'regression\n')
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if ((await detail()).events.some((e) => e.type === 'file_change')) break
      await new Promise((r) => setTimeout(r, 100))
    }
    await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/record-shell`,
      payload: { command: 'npm test', exitCode: 1 },
    })

    const analysis = (await app.inject({ method: 'GET', url: `/api/runs/${runId}/analysis` })).json()
    expect(analysis.summary).toContain('Possible regression introduced after checkpoint')
    expect(analysis.firstBadCheckpointId).toBeTruthy()
  })

  it('rejects an empty command', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/record-shell`,
      payload: { command: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404s for an unknown run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run_nope/record-shell',
      payload: { command: 'echo hi' },
    })
    expect(res.statusCode).toBe(404)
  })
})
