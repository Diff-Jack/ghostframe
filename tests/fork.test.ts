import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { RunDetail } from '../shared/types.js'
import { cleanup, makeTempHome, makeTempRepo, until } from './helpers/tmpRepo.js'

let app: FastifyInstance
let repo: string
let home: string
let runId: string

const detail = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/runs/${id}` })).json() as RunDetail

beforeAll(async () => {
  home = await makeTempHome('fork')
  process.env.GHOSTFRAME_HOME = home
  process.env.GHOSTFRAME_DEBOUNCE_MS = '300'
  repo = await makeTempRepo('fork')
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

describe('restore and fork through the API', () => {
  it('restores the workspace on disk and records a restore event', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'good state\n')
    await until(async () => (await detail(runId)).events.some((e) => e.type === 'file_change'))
    const good = (await detail(runId)).events.find((e) => e.type === 'file_change')!.checkpointId!

    await fs.writeFile(path.join(repo, 'src.txt'), 'the agent broke everything\n')
    await until(async () => (await detail(runId)).events.filter((e) => e.type === 'file_change').length >= 2)

    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/checkpoints/${good}/restore` })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)

    expect(await fs.readFile(path.join(repo, 'src.txt'), 'utf8')).toBe('good state\n')

    const d = await detail(runId)
    const restoreEvent = d.events.find((e) => e.type === 'restore')
    expect(restoreEvent).toBeTruthy()
    expect(restoreEvent!.restoredFromCheckpointId).toBe(good)
    expect(restoreEvent!.safetyCheckpointId).toBeTruthy()
  })

  it('forks into a new run linked to its parent', async () => {
    const d = await detail(runId)
    const cp = d.events.find((e) => e.type === 'file_change')!.checkpointId!

    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/checkpoints/${cp}/fork` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.run.parentRunId).toBe(runId)
    expect(body.run.forkedFromCheckpointId).toBe(cp)
    expect(body.run.status).toBe('recording')
    expect(body.safetyCheckpointId).toBeTruthy()

    // The parent stopped so only one recorder owns the repository.
    const parent = await detail(runId)
    expect(parent.run.status).toBe('completed')

    await app.inject({ method: 'POST', url: `/api/runs/${body.run.id}/stop` })
  })

  it('404s for an unknown checkpoint', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/checkpoints/cp_nope/restore` })
    expect(res.statusCode).toBe(404)
  })
})
