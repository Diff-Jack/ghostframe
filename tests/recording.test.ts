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

async function detail(): Promise<RunDetail> {
  const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
  expect(res.statusCode).toBe(200)
  return res.json() as RunDetail
}

beforeAll(async () => {
  home = await makeTempHome('rec')
  process.env.GHOSTFRAME_HOME = home
  process.env.GHOSTFRAME_DEBOUNCE_MS = '300'
  repo = await makeTempRepo('rec')
  const { buildApp } = await import('../server/app.js')
  app = await buildApp()
})

afterAll(async () => {
  const { stopAll } = await import('../server/core/recorder.js')
  await stopAll()
  await app?.close()
  await cleanup(home, repo)
})

describe('recording a run', () => {
  it('creates a run with a baseline checkpoint', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { repoPath: repo } })
    expect(res.statusCode).toBe(200)
    const run = res.json().run
    runId = run.id
    expect(run.status).toBe('recording')
    expect(run.repoPath).toBe(repo)
    expect(run.branch).toBe('main')

    const d = await detail()
    expect(d.events[0].type).toBe('run_start')
    expect(d.checkpoints.length).toBe(1)
  })

  it('refuses a second concurrent run on the same repository', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { repoPath: repo } })
    expect(res.statusCode).toBe(409)
  })

  it('records a file change with a real git diff and a checkpoint', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'original line\nagent added this\n')

    await until(async () => (await detail()).events.some((e) => e.type === 'file_change'))
    const d = await detail()

    const change = d.events.find((e) => e.type === 'file_change')!
    expect(change.files).toContain('src.txt')
    expect(change.diff).toContain('diff --git a/src.txt b/src.txt')
    expect(change.diff).toContain('+agent added this')
    expect(change.checkpointId).toBeTruthy()

    const cpEvent = d.events.find((e) => e.type === 'checkpoint' && e.checkpointId === change.checkpointId)
    expect(cpEvent).toBeTruthy()

    const cp = d.checkpoints.find((c) => c.id === change.checkpointId)!
    expect(cp.trackedPatch).toContain('+agent added this')
    expect(cp.gitHead).toMatch(/^[0-9a-f]{40}$/)
  })

  it('captures untracked files in the checkpoint', async () => {
    await fs.writeFile(path.join(repo, 'brand-new.txt'), 'created by the agent\n')

    await until(async () => {
      const d = await detail()
      return d.checkpoints.some((c) => c.untrackedFiles.some((f) => f.path === 'brand-new.txt'))
    })

    const d = await detail()
    const change = d.events.filter((e) => e.type === 'file_change').at(-1)!
    expect(change.files).toContain('brand-new.txt')
    expect(change.diff).toContain('created by the agent')
  })

  it('runs a shell command and records it as a shell event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/shell`,
      payload: { command: 'echo hello-ghostframe' },
    })
    expect(res.statusCode).toBe(200)
    const event = res.json().event
    expect(event.type).toBe('shell')
    expect(event.exitCode).toBe(0)
    expect(event.stdout).toContain('hello-ghostframe')
  })

  it('classifies known test runners as test events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/shell`,
      payload: { command: 'pytest --version || true' },
    })
    expect(res.json().event.type).toBe('test')
  })

  it('stops the run and marks it completed', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop` })
    expect(res.statusCode).toBe(200)
    expect(res.json().run.status).toBe('completed')
    expect(res.json().run.endedAt).toBeGreaterThan(0)

    const d = await detail()
    expect(d.events.at(-1)!.type).toBe('run_end')
  })

  it('lists the run afterwards', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    const { runs, activeRunIds } = res.json()
    expect(runs.some((r: { id: string }) => r.id === runId)).toBe(true)
    expect(activeRunIds).not.toContain(runId)
  })
})
