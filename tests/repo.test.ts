import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { cleanup, makeTempDir, makeTempHome, makeTempRepo } from './helpers/tmpRepo.js'

let app: FastifyInstance
let repo: string
let home: string
let plainDir: string

beforeAll(async () => {
  home = await makeTempHome('repo')
  process.env.GHOSTFRAME_HOME = home
  repo = await makeTempRepo('repo')
  plainDir = await makeTempDir('plain')
  const { buildApp } = await import('../server/app.js')
  app = await buildApp()
})

afterAll(async () => {
  await app?.close()
  await cleanup(home, repo, plainDir)
})

describe('opening a repository', () => {
  it('accepts a valid git repository', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repo/open', payload: { path: repo } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.repo.isGitRepo).toBe(true)
    expect(body.repo.path).toBe(repo)
    expect(body.repo.branch).toBe('main')
    expect(body.repo.headCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(body.repo.status).toBe('clean')
  })

  it('reports a dirty working tree', async () => {
    await fs.writeFile(path.join(repo, 'src.txt'), 'changed\n')
    const res = await app.inject({ method: 'POST', url: '/api/repo/open', payload: { path: repo } })
    expect(res.json().repo.status).toBe('dirty')
    await fs.writeFile(path.join(repo, 'src.txt'), 'original line\n')
  })

  it('rejects a directory that is not a git repository', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repo/open', payload: { path: plainDir } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('This directory is not a Git repository.')
  })

  it('rejects a path that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repo/open',
      payload: { path: path.join(plainDir, 'nope') },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/No such directory/)
  })

  it('rejects an empty path', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repo/open', payload: { path: '  ' } })
    expect(res.statusCode).toBe(400)
  })

  it('resolves a subdirectory to the repository root', async () => {
    const sub = path.join(repo, 'nested', 'deep')
    await fs.mkdir(sub, { recursive: true })
    const res = await app.inject({ method: 'POST', url: '/api/repo/open', payload: { path: sub } })
    expect(res.statusCode).toBe(200)
    expect(res.json().repo.path).toBe(repo)
    await fs.rm(path.join(repo, 'nested'), { recursive: true, force: true })
  })
})
